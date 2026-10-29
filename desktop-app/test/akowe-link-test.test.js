// test/akowe-link-test.test.js — the "🧪 Test Akọwe link" orchestration
// (akowe-link-test.js) against the REAL akowe-bridge.js HTTP server with
// fake panes, plus a fake Akọwe /api/ping server. No Electron.
// Run with: node test/akowe-link-test.test.js
const http = require("http");
const bridgeMod = require("../akowe-bridge");
const LT = require("../akowe-link-test");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

const KEY = "real-connection-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123";
const SITES = ["chatgpt", "claude", "gemini"];
const label = (s) => ({ chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" }[s] || s);

// A real bridge whose fake panes answer according to `mode(site, prompt)`:
// returns reply text, or null = never answer (timeout).
async function makeBridge({ mode, ready = {}, onSend } = {}) {
  const sends = [];
  const r = Object.assign({ chatgpt: true, claude: true, gemini: true }, ready);
  const bridge = bridgeMod.createBridge({
    port: 0,
    getToken: () => KEY,
    siteReady: (s) => r[s],
    timeScale: 0.002,
    sendToSite: async (site, text) => {
      sends.push({ site, text });
      if (onSend) onSend(site, text);
      const reply = mode ? mode(site, text) : null;
      if (reply != null) setTimeout(() => bridge.onCaptured({ site, text: `${reply}\n[FROM: ${site.toUpperCase()}]` }), 5);
      return { ok: true, seq: "0001" };
    }
  });
  await bridge.start();
  return { bridge, sends, port: bridge.status().port, ready: r };
}
// Echo the requested JSON (the "word" is read back from the prompt, like a good AI would).
function goodReply(site, text) {
  const m = /"word": "([a-z]+)"/.exec(text);
  return `{"ok": true, "site": "${site}", "word": "${m ? m[1] : "?"}"}`;
}
function pingServer(body, status = 200) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/api/ping` }));
  });
}
async function closedPortUrl() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return `http://127.0.0.1:${port}/api/ping`;
}
function baseDeps(B, extra = {}) {
  return Object.assign({
    sites: SITES.slice(),
    label,
    getStatus: () => ({ enabled: true, listening: true, host: "127.0.0.1", port: B.port, error: null }),
    keyFileExists: () => true,
    readKey: () => KEY,
    siteReady: (s) => B.ready[s],
    replyTimeoutMs: 10000, // contract minimum; timeScale makes it ~20 ms real
    pollMs: 10,
    stamp: "20261015-120000",
  }, extra);
}
const byId = (r, id) => r.results.find((x) => x.id === id);

async function main() {
  console.log("helpers");
  {
    const p = LT.buildPrompt("claude", "maple");
    assert(p.includes("JSON_SCHEMA:") && p.includes("END_JSON_SCHEMA") && p.split("\n")[p.split("\n").indexOf("JSON_SCHEMA:") + 2] === "END_JSON_SCHEMA", "prompt carries JSON_SCHEMA:/END_JSON_SCHEMA lines like Akọwe's adapter");
    assert(p.includes('"word": "maple"') && p.includes('"site": "claude"'), "prompt asks for the fixed JSON object with the random word");
    assert(LT.analyzeReply('{"ok":true}').how.includes("perfect"), "analyzeReply: bare JSON");
    assert(LT.analyzeReply('```json\n{"ok":true}\n```').obj.ok === true, "analyzeReply: fenced JSON");
    assert(LT.analyzeReply('Sure! {"ok":true} hope that helps').how.includes("extra words"), "analyzeReply: JSON with prose");
    assert(LT.analyzeReply("no json here").obj === null, "analyzeReply: no JSON");
    assert(LT.REPORT_NAME_RE.test("akowe-link-test-20261015-120000.md") && LT.REPORT_NAME_RE.test("akowe-link-test-20261015-120000.json"), "report name pattern accepts .md/.json reports");
    assert(!LT.REPORT_NAME_RE.test("../akowe-link-test-x.md") && !LT.REPORT_NAME_RE.test("feature-test-x.md") && !LT.REPORT_NAME_RE.test("akowe-link-test-x.exe"), "report name pattern rejects anything else");
  }

  console.log("everything passes (real bridge, real HTTP, Akọwe running)");
  {
    const B = await makeBridge({ mode: goodReply });
    const ping = await pingServer({ app: "akowe", version: "0.9" });
    const progress = [];
    const r = await LT.runLinkTest(baseDeps(B, { akoweUrl: ping.url, onProgress: (p) => progress.push(p) }));
    assert(r.ok && r.failCount === 0 && r.skipCount === 0 && r.passCount === r.total, `all ${r.total} steps pass (${r.passCount}/${r.total})`);
    assert(r.total === 4 + SITES.length * 2 + 1, "4 bridge steps + 2 per AI + Akọwe check");
    assert(/Everything works/.test(r.headline), "headline says everything works");
    assert(byId(r, "wrong_key").http_status === 401, "wrong key -> 401 recorded");
    assert(byId(r, "right_key").status === "pass", "right key accepted");
    for (const s of SITES) {
      const t = byId(r, `roundtrip:${s}`);
      assert(t.status === "pass" && t.request_id === `selftest-20261015-120000-${s}` && t.http_status === 200 && typeof t.elapsed_ms === "number", `${s}: real round trip with request_id selftest-<stamp>-${s}`);
      assert(typeof t.ending === "string" && t.ending.length <= LT.ENDING_CHARS && /perfect/.test(t.how_ended), `${s}: keeps only the reply's ending (<= ${LT.ENDING_CHARS} chars) and how it ended`);
    }
    assert(B.sends.length === 3 && B.sends.every((x) => x.text.includes("JSON_SCHEMA:")), "each Active AI really got the JSON_SCHEMA test prompt through the bridge");
    assert(/version 0\.9/.test(byId(r, "akowe_running").detail), "Akọwe ping PASS shows its version");
    assert(progress.some((p) => p.status === "running") && progress.filter((p) => p.status !== "running").length === r.total, "progress: a running + a result event per step");
    const st = B.bridge.status();
    assert(st.lastExternalContactAt === null && st.lastContactAt !== null, "the link test never counts as 'Akọwe connected' in the bridge");

    const md = LT.formatReport(r, { appVersion: "1.2.3", env: { os: "linux 6", arch: "x64", node: "20", electron: "43" }, akoweUrl: ping.url, activity: [{ at: Date.now(), kind: "connected", say: "Akọwe connected" }] });
    const js = JSON.stringify(LT.reportJson(r, { appVersion: "1.2.3", env: { os: "linux 6" }, akoweUrl: ping.url, activity: [{ at: Date.now(), kind: "connected", say: "Akọwe connected" }] }));
    for (const [name, txt] of [["Markdown", md], ["JSON", js]]) {
      assert(!txt.includes(KEY), `${name} report never contains the connection key`);
      assert(!txt.includes("JSON_SCHEMA") && !txt.includes("AutoInjector link test (automatic"), `${name} report never contains the prompt text`);
      assert(txt.includes("1.2.3"), `${name} report carries the app version`);
    }
    assert(/## Environment/.test(md) && /AutoInjector version: 1\.2\.3/.test(md) && /linux 6/.test(md) && new RegExp(`127\\.0\\.0\\.1:${B.port}`).test(md), "Markdown: environment (version, OS, bridge port)");
    assert(/## Steps/.test(md) && /✅ PASS/.test(md) && /## How each reply ended/.test(md) && /## Recent bridge activity/.test(md) && /Akọwe connected/.test(md), "Markdown: steps table, reply endings, recent activity");
    const j = JSON.parse(js);
    assert(j.counts.passed === r.passCount && j.steps.length === r.total && j.steps.every((s) => ["pass", "fail", "skip"].includes(s.result) && typeof s.ms === "number"), "JSON: counts + every step with result and timing");
    await B.bridge.stop(); ping.srv.close();
  }

  console.log("bridge off / port in use / no key");
  {
    const url = await closedPortUrl();
    let r = await LT.runLinkTest({ sites: ["claude"], label, getStatus: () => ({ enabled: false, listening: false, port: 17891 }), keyFileExists: () => true, readKey: () => KEY, akoweUrl: url, pollMs: 10 });
    assert(byId(r, "bridge_on").status === "fail" && /turned off/.test(byId(r, "bridge_on").detail) && /Turn the bridge on/.test(byId(r, "bridge_on").tip), "bridge off -> FAIL with how-to-fix");
    assert(["wrong_key", "right_key"].every((id) => byId(r, id).status === "skip"), "bridge off -> HTTP key checks skipped");
    assert(byId(r, "roundtrip:claude").status === "skip", "bridge off -> round trip skipped");
    r = await LT.runLinkTest({ sites: [], label, getStatus: () => ({ enabled: true, listening: false, port: 17891, error: "EADDRINUSE" }), keyFileExists: () => true, readKey: () => KEY, akoweUrl: url, pollMs: 10 });
    assert(/already being used/.test(byId(r, "bridge_on").detail) && /Another program/.test(byId(r, "bridge_on").tip), "port in use -> plain-English detail + fix");
    const B = await makeBridge({ mode: goodReply });
    r = await LT.runLinkTest(baseDeps(B, { sites: ["claude"], keyFileExists: () => false, readKey: () => "", akoweUrl: url }));
    assert(byId(r, "key_file").status === "fail" && byId(r, "right_key").status === "skip" && byId(r, "roundtrip:claude").status === "skip", "no key file -> FAIL, right-key + round trip skipped");
    await B.bridge.stop();
  }

  console.log("wrong key NOT refused (security failure)");
  {
    const url = await closedPortUrl();
    const fakeHttp = async (req) => (req.url.includes("/api/ping") ? Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })) : { status: 200, json: { ok: true, sites: {} } });
    const r = await LT.runLinkTest({ sites: [], label, http: fakeHttp, getStatus: () => ({ enabled: true, listening: true, port: 1 }), keyFileExists: () => true, readKey: () => KEY, akoweUrl: url, pollMs: 10 });
    assert(byId(r, "wrong_key").status === "fail" && /NOT refused/.test(byId(r, "wrong_key").detail) && /IMPORTANT/.test(byId(r, "wrong_key").tip), "a bridge that accepts a wrong key FAILS loudly");
  }

  console.log("pane not ready");
  {
    const url = await closedPortUrl();
    const B = await makeBridge({ mode: goodReply, ready: { gemini: false } });
    const r = await LT.runLinkTest(baseDeps(B, { akoweUrl: url }));
    assert(byId(r, "pane:gemini").status === "fail" && /missing or still loading/.test(byId(r, "pane:gemini").detail) && byId(r, "pane:gemini").tip, "Gemini not loaded -> FAIL with tip");
    assert(byId(r, "roundtrip:gemini").status === "skip", "...and its round trip is skipped");
    assert(byId(r, "roundtrip:claude").status === "pass" && byId(r, "roundtrip:chatgpt").status === "pass", "the other AIs still pass");
    assert(B.sends.every((s) => s.site !== "gemini"), "nothing was sent to the unready pane");
    assert(/1 problem found/.test(r.headline), "headline counts the problem");
    await B.bridge.stop();
  }

  console.log("timeout");
  {
    const url = await closedPortUrl();
    const B = await makeBridge({ mode: (site, text) => (site === "claude" ? null : goodReply(site, text)) });
    const r = await LT.runLinkTest(baseDeps(B, { akoweUrl: url }));
    const t = byId(r, "roundtrip:claude");
    assert(t.status === "fail" && t.http_status === 504 && /timed out/.test(t.detail) && /\[FROM: NAME\]/.test(t.tip), "no reply -> 504 -> FAIL 'timed out' with a fix tip");
    assert(byId(r, "roundtrip:gemini").status === "pass", "a timeout on one AI doesn't stop the others");
    await B.bridge.stop();
  }

  console.log("bad JSON / wrong word");
  {
    const url = await closedPortUrl();
    const B = await makeBridge({ mode: (site, text) => (site === "chatgpt" ? "Sure! Here is a premise about dragons." : site === "claude" ? '{"ok": true, "site": "claude", "word": "notit"}' : "```json\n" + goodReply(site, text) + "\n```") });
    const r = await LT.runLinkTest(baseDeps(B, { akoweUrl: url }));
    assert(byId(r, "roundtrip:chatgpt").status === "fail" && /no JSON object/.test(byId(r, "roundtrip:chatgpt").detail) && /re-asks/.test(byId(r, "roundtrip:chatgpt").tip), "prose instead of JSON -> FAIL (bad JSON)");
    assert(byId(r, "roundtrip:chatgpt").ending === "Sure! Here is a premise about dragons.", "the raw ending of the bad reply is recorded");
    assert(byId(r, "roundtrip:claude").status === "fail" && /did not repeat the test word/.test(byId(r, "roundtrip:claude").detail), "JSON without the random word -> FAIL");
    assert(byId(r, "roundtrip:gemini").status === "pass" && /code block/.test(byId(r, "roundtrip:gemini").how_ended), "fenced JSON still passes and says how it ended");
    await B.bridge.stop();
  }

  console.log("Akọwe not running / not Akọwe");
  {
    const B = await makeBridge({ mode: goodReply });
    let r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: await closedPortUrl() }));
    const b = byId(r, "akowe_running");
    assert(b.status === "skip" && /isn't running/.test(b.detail) && /run-akowe/.test(b.detail), "Akọwe down -> SKIPPED with instructions (not a failure)");
    assert(r.failCount === 0, "Akọwe being down is not counted as a failure");
    const other = await pingServer({ hello: "world" }, 404);
    r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: other.url }));
    assert(byId(r, "akowe_running").status === "skip" && /didn't say it is Akọwe/.test(byId(r, "akowe_running").detail), "something else on the port -> SKIPPED, explained");
    other.srv.close();
    await B.bridge.stop();
  }

  console.log("stop mid-run");
  {
    let stop = false;
    const B = await makeBridge({ mode: (site) => (site === "chatgpt" ? null : null), onSend: () => { stop = true; } });
    const t0 = Date.now();
    const r = await LT.runLinkTest(baseDeps(B, { akoweUrl: await closedPortUrl(), replyTimeoutMs: 600000, shouldStop: () => stop }));
    assert(Date.now() - t0 < 3000, "stopping returns promptly instead of waiting for the reply");
    assert(r.stopped === true && /stopped/i.test(r.headline), "result says it was stopped");
    assert(byId(r, "roundtrip:chatgpt").status === "skip" && /Stopped by you/.test(byId(r, "roundtrip:chatgpt").detail), "the in-flight round trip is SKIPPED 'Stopped by you'");
    assert(r.total === 4 + 6 + 1 && ["roundtrip:claude", "roundtrip:gemini", "akowe_running"].every((id) => byId(r, id) && byId(r, id).status === "skip"), "every remaining step is recorded as skipped (report stays complete)");
    assert(B.sends.length === 1, "nothing more was sent after Stop");
    await B.bridge.stop();
  }

  console.log("busy site");
  {
    const B = await makeBridge({ mode: () => null });
    // occupy claude with a "Akọwe" request
    const occupy = new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify({ site: "claude", prompt: "x", request_id: "bf-busy", timeout_ms: 600000 }));
      const req = http.request({ host: "127.0.0.1", port: B.port, method: "POST", path: "/v1/complete", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Content-Length": data.length }, agent: false }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", resolve); req.write(data); req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    const r = await LT.runLinkTest(baseDeps(B, { sites: ["claude"], akoweUrl: await closedPortUrl() }));
    assert(byId(r, "pane:claude").status === "skip" && /busy/.test(byId(r, "pane:claude").detail), "an AI busy with Akọwe is SKIPPED, not failed");
    assert(byId(r, "roundtrip:claude").status === "skip", "...and its round trip is skipped (nothing sent over Akọwe's request)");
    await B.bridge.stop();
    await occupy;
  }

  console.log("optional 'Akọwe is connected' step (getConnection)");
  {
    const B = await makeBridge({ mode: goodReply });
    const closed = await closedPortUrl();
    let r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: closed }));
    assert(!byId(r, "akowe_connected") && r.total === 5, "without getConnection there is no connection step (old step list unchanged)");
    let t = 1000000;
    r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: closed, now: () => t, getConnection: () => ({ connected: false, paired: false }) }));
    const c = byId(r, "akowe_connected");
    assert(c && c.status === "skip" && /Connect Akọwe/.test(c.detail) && r.results[r.results.length - 1].id === "akowe_connected" && r.total === 6, "not connected -> SKIPPED (never failed) with 'press Connect Akọwe', as the last step");
    r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: closed, getConnection: () => ({ connected: false, paired: true }) }));
    assert(byId(r, "akowe_connected").status === "skip" && /picked up the key/.test(byId(r, "akowe_connected").detail), "paired but no report yet -> SKIPPED, explained");
    r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: closed, now: () => t, getConnection: () => ({ connected: true, statusAt: t - 12000, stale: false }) }));
    assert(byId(r, "akowe_connected").status === "pass" && /sent an update on your book 12s ago/.test(byId(r, "akowe_connected").detail), "connected with a fresh status -> PASS with its age");
    r = await LT.runLinkTest(baseDeps(B, { sites: [], akoweUrl: closed, getConnection: () => { throw new Error("boom"); } }));
    assert(byId(r, "akowe_connected").status === "skip", "a getConnection error is handled (SKIPPED, no crash)");
    await B.bridge.stop();
  }

  console.log("PC test 2026-10-28: Claude's site shows quotes as “ ”");
  {
    const curly = (t) => t.replace(/"([^"]*)"/g, "“$1”");
    let a = LT.analyzeReply(curly('{"ok": true, "site": "claude", "word": "harbor"}'));
    assert(a.obj && a.obj.word === "harbor" && a.curly === true && /curly/.test(a.how), `curly-quote JSON is read (${a.how})`);
    a = LT.analyzeReply("```json\n" + curly('{"ok": true, "word": "maple"}') + "\n```");
    assert(a.obj && a.obj.word === "maple", "…also inside a code block");
    a = LT.analyzeReply('{"ok": true, "word": "maple", "note": "the “best”"}');
    assert(a.obj && a.obj.note === "the “best”" && a.curly === false && !/curly/.test(a.how), "valid JSON with curly quotes in its words is read as it is");
    // the whole round trip: the AI's answer arrives with curly quotes
    const B = await makeBridge({ mode: (site, text) => curly(goodReply(site, text)) });
    let r = await LT.runLinkTest(baseDeps(B, { sites: ["claude"], akoweUrl: await closedPortUrl() }));
    let t = byId(r, "roundtrip:claude");
    assert(t.status === "pass" && /curly/.test(t.detail) && t.curly_quotes === true, `round trip PASSES with curly quotes (${t.status}: ${t.detail})`);
    const want = curly(goodReply("claude", B.sends[0].text)).length; // 47–49 characters, by the random word (48 in the PC log)
    assert(t.reply_chars === want && !t.reply_excerpt, `the whole ${want}-character answer arrived (in the PC log 48 = the whole reply, not a cut-off) and a pass keeps no excerpt (${t.reply_chars})`);
    await B.bridge.stop();
    // a reply that really is not the JSON: "Technical details" shows what the AI wrote
    const B2 = await makeBridge({ mode: () => "Sure! Here is a fun fact about harbors instead." });
    const progress = [];
    r = await LT.runLinkTest(baseDeps(B2, { sites: ["claude"], akoweUrl: await closedPortUrl(), onProgress: (p) => progress.push(p) }));
    t = byId(r, "roundtrip:claude");
    assert(t.status === "fail" && t.reply_excerpt === "Sure! Here is a fun fact about harbors instead.", `a failed reply keeps a one-line excerpt of what the AI wrote (${JSON.stringify(t.reply_excerpt)})`);
    assert(progress.some((p) => p.id === "roundtrip:claude" && p.status === "fail" && p.reply_excerpt === t.reply_excerpt && p.http_status === 200), "…and the progress event the panel gets carries it (and the HTTP status)");
    const md = LT.formatReport(r, {});
    const js = LT.reportJson(r, {});
    assert(/What Claude wrote: Sure! Here is a fun fact/.test(md) && js.steps.find((x) => x.id === "roundtrip:claude").reply_excerpt === t.reply_excerpt, "the saved report (Markdown + JSON) shows it too");
    assert(!md.includes(KEY) && !JSON.stringify(js).includes(KEY), "still never the key");
    await B2.bridge.stop();
    const long = "x".repeat(900);
    const B3 = await makeBridge({ mode: () => long });
    r = await LT.runLinkTest(baseDeps(B3, { sites: ["claude"], akoweUrl: await closedPortUrl() }));
    t = byId(r, "roundtrip:claude");
    assert(t.reply_excerpt.length === LT.REPLY_EXCERPT_CHARS && t.reply_excerpt.endsWith("…"), `a long reply is cut to ${LT.REPLY_EXCERPT_CHARS} characters`);
    await B3.bridge.stop();
  }

  console.log("PC test 2026-10-28: a message that never arrived is not 'had not finished answering'");
  {
    const bridge = bridgeMod.createBridge({
      port: 0, getToken: () => KEY, siteReady: () => true, timeScale: 0.002,
      // typed, the box emptied, but it never showed up in the chat (verified: false)
      sendToSite: async () => ({ ok: true, seq: "0007", verified: false })
    });
    await bridge.start();
    const B = { bridge, port: bridge.status().port, ready: { chatgpt: true, claude: true, gemini: true } };
    const r = await LT.runLinkTest(baseDeps(B, { sites: ["chatgpt"], akoweUrl: await closedPortUrl() }));
    const t = byId(r, "roundtrip:chatgpt");
    assert(t.status === "fail" && /never showed up in ChatGPT's chat/.test(t.detail) && !/had not finished answering/.test(t.detail), `says it never arrived (${t.detail})`);
    assert(t.tip === LT.TIPS.roundtrip_not_delivered && /🎯/.test(t.tip), "the tip points at a saved Send button (🎯 / 🔢)");
    const ev = bridge.status().events.find((e) => e.kind === "outcome" && e.outcome === "TIMEOUT");
    assert(ev && ev.delivered === "no" && /never arrived/.test(bridgeMod.describeEvent(ev, label).say), `the activity feed says so too (${ev && bridgeMod.describeEvent(ev, label).say})`);
    await bridge.stop();
    // a proven send that timed out still says "had not finished answering"
    const bridge2 = bridgeMod.createBridge({ port: 0, getToken: () => KEY, siteReady: () => true, timeScale: 0.002, sendToSite: async () => ({ ok: true, seq: "0008", verified: true }) });
    await bridge2.start();
    const r2 = await LT.runLinkTest(baseDeps({ bridge: bridge2, port: bridge2.status().port, ready: B.ready }, { sites: ["chatgpt"], akoweUrl: await closedPortUrl() }));
    assert(/had not finished answering/.test(byId(r2, "roundtrip:chatgpt").detail), "a send that DID arrive and timed out keeps the old wording");
    await bridge2.stop();
  }

  console.log("\n== two runs in the same second never share a stamp (request_ids / reports) ==");
  {
    const taken = new Set(["20261015-120000", "20261015-120000-2"]);
    assert(LT.uniqueStamp("20261015-120001", (s) => taken.has(s)) === "20261015-120001", "a free stamp is kept as it is");
    const st = LT.uniqueStamp("20261015-120000", (s) => taken.has(s));
    assert(st === "20261015-120000-3" && LT.REPORT_NAME_RE.test(`akowe-link-test-${st}.md`), `a stamp already used gets the next free suffix (${st}) and is still a valid report name`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
