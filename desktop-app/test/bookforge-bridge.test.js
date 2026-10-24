// test/bookforge-bridge.test.js — exercises the REAL bookforge-bridge.js HTTP
// server (pure Node, no Electron) against contract v1
// (docs/BOOKFORGE_AUTOINJECTOR_BRIDGE.md) with fake sendToSite/siteReady.
// Run with: node test/bookforge-bridge.test.js
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bridgeMod = require("../bookforge-bridge");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz-0123";
const SECRET_PROMPT = "TOPSECRET-PROMPT-TEXT-zq9";
const SECRET_REPLY = "TOPSECRET-REPLY-TEXT-xk7";

function request(port, method, urlPath, { token = TOKEN, body, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody != null ? rawBody : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// A harness: fake panes whose behaviour each test controls.
function makeHarness(extra = {}) {
  const logs = [];
  const sends = [];
  const ready = { chatgpt: true, claude: true, gemini: true };
  let sendImpl = async () => ({ ok: true, seq: String(sends.length).padStart(4, "0") });
  let seqN = 0;
  const bridge = bridgeMod.createBridge({
    port: 0,
    getToken: () => TOKEN,
    siteReady: (s) => ready[s],
    sendToSite: (site, text, meta) => { sends.push({ site, text, meta }); seqN++; return sendImpl(site, text, meta, seqN); },
    logger: (kind, detail) => logs.push(JSON.stringify({ kind, detail })),
    timeScale: 0.002, // 10000 ms contract minimum -> 20 ms real
    ...extra
  });
  return {
    bridge, logs, sends, ready,
    setSend(fn) { sendImpl = fn; },
    get port() { return bridge.status().port; }
  };
}

function completeBody(over = {}) {
  return { site: "claude", prompt: SECRET_PROMPT, request_id: "bf-req-1", timeout_ms: 10000, ...over };
}

async function main() {
  // --- token helpers -----------------------------------------------------------
  console.log("token file");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-bridge-"));
    const t1 = bridgeMod.loadOrCreateToken(dir);
    assert(/^[A-Za-z0-9_-]{32,}$/.test(t1), "generated token is URL-safe and >= 24 bytes of entropy");
    assert(bridgeMod.loadOrCreateToken(dir) === t1, "existing token is reused, not regenerated");
    if (process.platform !== "win32") {
      const mode = fs.statSync(bridgeMod.tokenPath(dir)).mode & 0o777;
      assert(mode === 0o600, `token file mode is 0600 (got ${mode.toString(8)})`);
    }
    const t2 = bridgeMod.regenerateToken(dir);
    assert(t2 !== t1 && bridgeMod.readToken(dir) === t2, "regenerate writes a new token");
    assert(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "no temp files left behind");
  }

  console.log("binding");
  assert((() => { try { bridgeMod.createBridge({ host: "0.0.0.0", sendToSite: async () => ({ ok: true }) }); return false; } catch (_) { return true; } })(),
    "refuses to bind 0.0.0.0");
  const H = makeHarness();
  await H.bridge.start();
  const addr = H.bridge.address();
  assert(addr.address === "127.0.0.1", `server binds 127.0.0.1 only (got ${addr.address})`);
  assert(H.bridge.status().listening === true && H.port > 0, "status() reports listening + port");
  const port = H.port;

  console.log("auth");
  let r = await request(port, "GET", "/v1/health", { token: null });
  assert(r.status === 401 && r.json && r.json.error === "UNAUTHORIZED" && r.json.ambiguous === false, "401 when token missing");
  r = await request(port, "GET", "/v1/health", { token: "wrong-token" });
  assert(r.status === 401 && r.json.error === "UNAUTHORIZED", "401 when token wrong");
  r = await request(port, "POST", "/v1/complete", { token: TOKEN + "x", body: completeBody() });
  assert(r.status === 401 && H.sends.length === 0, "401 on /v1/complete with wrong token; nothing sent");
  r = await request(port, "GET", "/v1/health", { token: null, headers: { Authorization: `Basic ${TOKEN}` } });
  assert(r.status === 401, "401 for a non-Bearer scheme");

  console.log("health");
  r = await request(port, "GET", "/v1/health");
  assert(r.status === 200 && r.json.ok === true && r.json.bridge_version === "1.2", "health 200 with bridge_version 1.2 (contract v1.2, backward compatible)");
  assert(["chatgpt", "claude", "gemini"].every((s) => r.json.sites[s] && r.json.sites[s].ready === true && r.json.sites[s].busy === false), "health lists every site ready/not busy");
  r = await request(port, "GET", "/v1/nope");
  assert(r.status === 404 && r.json.error === "NOT_FOUND", "404 NOT_FOUND for unknown path");

  console.log("validation");
  const bad = [
    [{ rawBody: Buffer.from("not json") }, "non-JSON body"],
    [{ body: [1, 2] }, "array body"],
    [{ body: completeBody({ site: undefined }) }, "missing site"],
    [{ body: completeBody({ prompt: "" }) }, "empty prompt"],
    [{ body: completeBody({ prompt: "   " }) }, "whitespace-only prompt"],
    [{ body: completeBody({ prompt: 5 }) }, "non-string prompt"],
    [{ body: completeBody({ request_id: undefined }) }, "missing request_id"],
    [{ body: completeBody({ request_id: "has space" }) }, "request_id with bad chars"],
    [{ body: completeBody({ request_id: "x".repeat(129) }) }, "request_id over 128 chars"],
    [{ body: completeBody({ timeout_ms: 9999 }) }, "timeout_ms below 10000"],
    [{ body: completeBody({ timeout_ms: 900001 }) }, "timeout_ms above 900000"],
    [{ body: completeBody({ timeout_ms: 20000.5 }) }, "non-integer timeout_ms"],
    [{ body: completeBody({ timeout_ms: "20000" }) }, "string timeout_ms"]
  ];
  for (const [o, label] of bad) {
    r = await request(port, "POST", "/v1/complete", o);
    assert(r.status === 400 && r.json && r.json.error === "BAD_REQUEST" && r.json.ambiguous === false, `400 BAD_REQUEST: ${label}`);
  }
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ site: "bard" }) });
  assert(r.status === 404 && r.json.error === "UNKNOWN_SITE", "404 UNKNOWN_SITE for an unknown site");
  assert(H.sends.length === 0, "no invalid request sent anything");

  console.log("413");
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ prompt: "a".repeat(1024 * 1024 + 10) }) });
  assert(r.status === 413 && r.json.error === "TOO_LARGE", "413 TOO_LARGE for a body over 1 MiB");
  assert(H.sends.length === 0, "oversized body not sent");

  console.log("happy path");
  H.setSend(async (site, text) => {
    setTimeout(() => H.bridge.onCaptured({ site, text: `[TO: USER]\n${SECRET_REPLY}\n\n[FROM: ${site.toUpperCase()}]` }), 5);
    return { ok: true, seq: "0007" };
  });
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "happy-1", timeout_ms: 60000 }) });
  assert(r.status === 200 && r.json.ok === true, "200 ok");
  assert(r.json.text === SECRET_REPLY, "reply text is envelope-stripped");
  assert(r.json.site === "claude" && r.json.request_id === "happy-1" && r.json.seq === "0007" && typeof r.json.elapsed_ms === "number", "site/request_id/seq/elapsed_ms present");
  const sent = H.sends[H.sends.length - 1];
  assert(sent.site === "claude" && sent.text.startsWith(SECRET_PROMPT) && /\[FROM: CLAUDE\]/.test(sent.text), "prompt sent with [FROM: CLAUDE] envelope instruction");
  assert(sent.meta && sent.meta.request_id === "happy-1", "sendToSite gets meta.request_id");
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.claude.busy === false, "site freed after reply");

  console.log("idempotent replay");
  const before = H.sends.length;
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "happy-1", timeout_ms: 60000 }) });
  assert(r.status === 200 && r.json.text === SECRET_REPLY && r.json.seq === "0007", "repeat of a completed request_id returns the cached 200");
  assert(H.sends.length === before, "cached replay does not re-send");
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ site: "gemini", request_id: "happy-1" }) });
  assert(r.status === 400, "same request_id for a different site is rejected");

  console.log("onCaptured for unrelated turns");
  assert(H.bridge.onCaptured({ site: "chatgpt", text: "hello" }) === false, "onCaptured false when no bridge request for that site");
  assert(H.bridge.onCaptured(null) === false && H.bridge.onCaptured({ text: "x" }) === false, "onCaptured false for malformed turns");

  console.log("busy + in-flight join");
  let captureLater = null;
  H.setSend(async (site) => { captureLater = () => H.bridge.onCaptured({ site, text: `${SECRET_REPLY} [FROM: ${site.toUpperCase()}]` }); return { ok: true, seq: "0010" }; });
  const p1 = request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "busy-1", timeout_ms: 600000 }) });
  await sleep(30);
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.claude.busy === true, "health shows the site busy while in flight");
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "busy-2", timeout_ms: 600000 }) });
  assert(r.status === 409 && r.json.error === "SITE_BUSY" && r.json.ambiguous === false, "409 SITE_BUSY for a different request_id on a busy site");
  const sendsBeforeJoin = H.sends.length;
  const p2 = request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "busy-1", timeout_ms: 600000 }) });
  await sleep(30);
  assert(H.sends.length === sendsBeforeJoin, "in-flight join does not re-send");
  assert(H.bridge.onCaptured({ site: "gemini", text: "other" }) === false, "a capture from another site is not consumed");
  assert(captureLater() === true, "onCaptured returns true for the bridge's own reply");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert(r1.status === 200 && r2.status === 200 && r1.json.text === SECRET_REPLY && r2.json.text === SECRET_REPLY, "original and joined request both get the same 200");
  assert(H.bridge.onCaptured({ site: "claude", text: "again" }) === false, "a second capture after completion is not consumed");

  console.log("timeout + late reply");
  let lateCapture = null;
  H.setSend(async (site) => { lateCapture = () => H.bridge.onCaptured({ site, text: `late ${SECRET_REPLY} [FROM: CLAUDE]` }); return { ok: true, seq: "0011" }; });
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "slow-1", timeout_ms: 10000 }) }); // 20 ms real
  assert(r.status === 504 && r.json.error === "TIMEOUT" && r.json.ambiguous === true, "504 TIMEOUT ambiguous:true");
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.claude.busy === true, "site stays busy after 504 (late-reply window)");
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "slow-2" }) });
  assert(r.status === 409, "a new request_id is still 409 during the late window");
  const sendsBeforeLate = H.sends.length;
  assert(lateCapture() === true, "late reply is consumed by the bridge");
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "slow-1" }) });
  assert(r.status === 200 && r.json.text === `late ${SECRET_REPLY}` && r.json.request_id === "slow-1", "retry with the same request_id returns the late reply from cache");
  assert(H.sends.length === sendsBeforeLate, "late-reply retry does not re-send");
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.claude.busy === false, "site freed once the late reply is stored");

  console.log("late window expiry");
  H.setSend(async () => ({ ok: true, seq: "0012" }));
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "never-1", timeout_ms: 10000 }) });
  assert(r.status === 504, "504 when nothing ever arrives");
  await sleep(60); // > another timeout_ms (20 ms real)
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.claude.busy === false, "site frees after timeout_ms more with no reply");
  assert(H.bridge.onCaptured({ site: "claude", text: "too late" }) === false, "a reply after the late window is not consumed");

  console.log("send failures");
  H.setSend(async () => ({ ok: false, error: "SEND_NOT_CONFIRMED" }));
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "fail-1" }) });
  assert(r.status === 502 && r.json.error === "SEND_FAILED" && r.json.ambiguous === false, "502 SEND_FAILED when delivery fails");
  H.setSend(async () => { throw new Error("boom"); });
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "fail-2" }) });
  assert(r.status === 502 && r.json.error === "SEND_FAILED", "502 SEND_FAILED when sendToSite throws");
  H.setSend(async () => ({ ok: false, error: "NO_VIEW" }));
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "fail-3" }) });
  assert(r.status === 503 && r.json.error === "SITE_NOT_READY", "503 when the send path reports NO_VIEW");
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.claude.busy === false, "site freed after send failures");
  H.setSend(async (site) => { setTimeout(() => H.bridge.onCaptured({ site, text: "fine [FROM: CLAUDE]" }), 5); return { ok: true, seq: "0013" }; });
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ request_id: "fail-1", timeout_ms: 60000 }) });
  assert(r.status === 200 && r.json.text === "fine", "a failed request_id is not cached — retry re-sends and succeeds");

  console.log("503 not ready");
  H.ready.gemini = false;
  const sendsBefore503 = H.sends.length;
  r = await request(port, "POST", "/v1/complete", { body: completeBody({ site: "gemini", request_id: "nr-1" }) });
  assert(r.status === 503 && r.json.error === "SITE_NOT_READY" && r.json.ambiguous === false, "503 SITE_NOT_READY when the pane is not ready");
  assert(H.sends.length === sendsBefore503, "nothing sent to a not-ready pane");
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.gemini.ready === false, "health reports ready:false");
  H.ready.gemini = true;

  console.log("cache expiry");
  {
    let fakeNow = 1_000_000;
    const E = makeHarness({ now: () => fakeNow });
    await E.bridge.start();
    E.setSend(async (site) => { setTimeout(() => E.bridge.onCaptured({ site, text: "x [FROM: CLAUDE]" }), 2); return { ok: true, seq: "0001" }; });
    r = await request(E.port, "POST", "/v1/complete", { body: completeBody({ request_id: "exp-1", timeout_ms: 600000 }) });
    assert(r.status === 200 && E.sends.length === 1, "first call sends");
    fakeNow += 14 * 60 * 1000;
    await request(E.port, "POST", "/v1/complete", { body: completeBody({ request_id: "exp-1", timeout_ms: 600000 }) });
    assert(E.sends.length === 1, "still cached at 14 minutes");
    fakeNow += 2 * 60 * 1000;
    await request(E.port, "POST", "/v1/complete", { body: completeBody({ request_id: "exp-1", timeout_ms: 600000 }) });
    assert(E.sends.length === 2, "cache expires after 15 minutes (re-sends)");
    await E.bridge.stop();
  }

  console.log("logging hygiene");
  const allLogs = H.logs.join("\n");
  assert(H.logs.length > 0, "the bridge logged events");
  assert(!allLogs.includes(SECRET_PROMPT), "no prompt text in logger output");
  assert(!allLogs.includes(SECRET_REPLY), "no reply text in logger output");
  assert(!allLogs.includes(TOKEN), "no token in logger output");

  console.log("activity: status() ring buffer, counters, last contact (text-free)");
  {
    const st = H.bridge.status();
    const dump = JSON.stringify(st);
    assert(Array.isArray(st.events) && st.events.length > 0 && st.events.length <= bridgeMod.EVENT_RING_SIZE, "status().events is a bounded ring of recent events");
    assert(!dump.includes(SECRET_PROMPT) && !dump.includes(SECRET_REPLY), "status() (events included) never carries prompt/reply text");
    assert(!dump.includes(TOKEN) && !dump.includes("wrong-token"), "status() never carries the real key or a presented wrong key");
    assert(st.events.some((e) => e.kind === "unauthorized" && e.http_status === 401), "a wrong-key attempt is recorded as an 'unauthorized' event");
    assert(st.counters.unauthorized >= 4, `unauthorized attempts are counted (${st.counters.unauthorized})`);
    assert(st.events.some((e) => e.kind === "outcome" && e.outcome === "OK" && e.site === "claude" && e.http_status === 200 && typeof e.elapsed_ms === "number"), "a completed request is an OK outcome event with site/http_status/elapsed_ms");
    assert(st.events.some((e) => e.kind === "outcome" && e.outcome === "BAD_REQUEST" && e.http_status === 400), "refused (400) requests are recorded");
    assert(st.events.every((e) => Object.keys(e).every((k) => ["kind", "at", "site", "request_id", "outcome", "elapsed_ms", "http_status", "port", "error", "selftest"].includes(k))), "events only ever carry whitelisted fields");
    assert(typeof st.lastContactAt === "number" && typeof st.lastExternalContactAt === "number", "lastContactAt / lastExternalContactAt are set after authenticated requests");
    assert(st.counters.requests >= 1 && st.counters.answered >= 1 && st.counters.timeouts >= 1, "counters track requests / answered / timeouts");
    assert(st.siteLast.claude && typeof st.siteLast.claude.outcome === "string", "siteLast reports each site's last result");
    assert(st.active && typeof st.active === "object", "status().active lists in-flight requests per site");
  }
  {
    let t = 1000000;
    const seen = [];
    const A = makeHarness({ now: () => t, onEvent: (e) => seen.push(e) });
    await A.bridge.start();
    let st = A.bridge.status();
    assert(st.lastContactAt === null && st.lastExternalContactAt === null, "no contact recorded before any request");
    assert(seen.some((e) => e.kind === "listening" && e.port === A.port), "onEvent fires for 'listening' (with the port)");
    await request(A.port, "GET", "/v1/health", { token: "presented-wrong-KEY-123456789" });
    st = A.bridge.status();
    assert(st.lastContactAt === null, "an unauthenticated attempt does not count as contact");
    assert(!JSON.stringify(seen).includes("presented-wrong-KEY-123456789"), "the presented wrong key never reaches onEvent");
    await request(A.port, "GET", "/v1/health", { headers: { "X-AutoInjector-Selftest": "1" } });
    st = A.bridge.status();
    assert(st.lastContactAt === t && st.lastExternalContactAt === null, "a self-test health check updates lastContactAt only");
    assert(!seen.some((e) => e.kind === "connected"), "the app's own link test never produces 'BookForge connected'");
    t += 1000;
    await request(A.port, "GET", "/v1/health");
    st = A.bridge.status();
    assert(st.lastExternalContactAt === t && seen.filter((e) => e.kind === "connected").length === 1, "first real authenticated request -> lastExternalContactAt + one 'connected' event");
    t += 1000;
    await request(A.port, "GET", "/v1/health");
    assert(seen.filter((e) => e.kind === "connected").length === 1, "repeated contact within the gap doesn't spam 'connected'");
    A.setSend(async (site) => { setTimeout(() => A.bridge.onCaptured({ site, text: `${SECRET_REPLY} [FROM: ${site.toUpperCase()}]` }), 5); return { ok: true, seq: "0001" }; });
    await request(A.port, "POST", "/v1/complete", { body: completeBody({ site: "gemini", request_id: "selftest-1-gemini", timeout_ms: 60000 }) });
    const self = seen.filter((e) => e.request_id === "selftest-1-gemini");
    assert(self.length >= 2 && self.every((e) => e.selftest === true), "selftest-* request events are flagged selftest");
    st = A.bridge.status();
    assert(st.siteLast.gemini && st.siteLast.gemini.selftest === true && st.siteLast.gemini.outcome === "OK", "siteLast keeps the selftest flag");
    // ring buffer bound
    for (let i = 0; i < bridgeMod.EVENT_RING_SIZE + 10; i++) A.bridge.recordEvent("key_changed", { prompt: SECRET_PROMPT, text: SECRET_REPLY, token: TOKEN });
    st = A.bridge.status();
    assert(st.events.length === bridgeMod.EVENT_RING_SIZE, `ring buffer capped at ${bridgeMod.EVENT_RING_SIZE}`);
    assert(!JSON.stringify(st).includes(SECRET_PROMPT) && !JSON.stringify(st).includes(TOKEN) && !JSON.stringify(seen).includes(SECRET_REPLY), "recordEvent drops non-whitelisted fields (text/key can't leak even if passed)");
    await A.bridge.stop();
    assert(seen.some((e) => e.kind === "stopped"), "onEvent fires for 'stopped'");
  }

  // --- BF-01: a reply is the bridge's only if it answers the bridge's own [MSG #] --------
  console.log("ownership by [MSG #] seq (BF-01)");
  {
    const O = makeHarness();
    await O.bridge.start();
    let typed = null;
    O.setSend(() => new Promise((resolve) => { typed = resolve; }));
    const p = request(O.port, "POST", "/v1/complete", { body: completeBody({ request_id: "own-1", timeout_ms: 600000 }) });
    await sleep(30);
    assert(O.bridge.awaitingReply("claude") === false, "awaitingReply is false while the prompt is still queued");
    assert(O.bridge.onCaptured({ site: "claude", text: "the user's side answer [FROM: CLAUDE]", answers: ["0020"] }) === false,
      "a reply captured while the prompt is still queued (not typed) is never taken");
    assert(O.bridge.onCaptured({ site: "claude", text: "no trace info [FROM: CLAUDE]" }) === false,
      "...not even without Relay Trace info");
    typed({ ok: true, seq: "0021" });
    await sleep(10);
    assert(O.bridge.awaitingReply("claude") === true, "awaitingReply is true once the prompt was typed");
    assert(O.bridge.onCaptured({ site: "claude", text: "older reply [FROM: CLAUDE]", answers: ["0020"] }) === false,
      "a reply the Relay Trace says answers an older message (#0020) is not taken");
    assert(O.bridge.onCaptured({ site: "claude", text: "older again [FROM: CLAUDE]", answers: [] }) === false,
      "a reply that answers nothing open is not taken");
    assert(O.bridge.onCaptured({ site: "claude", text: "before typing [FROM: CLAUDE]", ts: 0 }) === false,
      "without trace info, a reply captured before the prompt was typed is not taken");
    assert(O.bridge.onCaptured({ site: "claude", text: `${SECRET_REPLY} [FROM: CLAUDE]`, answers: ["0020", "0021"] }) === true,
      "the reply that answers #0021 is taken");
    r = await p;
    assert(r.status === 200 && r.json.text === SECRET_REPLY && r.json.seq === "0021" && r.json.reply_to === "0021",
      "the 200 carries seq and reply_to = the [MSG #] it answers");
    assert(O.bridge.awaitingReply("claude") === false, "awaitingReply false once answered");
    await O.bridge.stop();
  }

  // --- BF-02: a prompt not typed by the timeout is withdrawn; the 504 says so -------------
  console.log("timeout before typing: the queued send is withdrawn (BF-02)");
  {
    const C = makeHarness();
    await C.bridge.start();
    let token = null;
    C.setSend(async (site, text, meta) => {
      token = meta.cancelToken;
      while (!meta.cancelToken.cancelled) await sleep(2); // "the AI is busy"
      return { ok: false, error: "CANCELLED" };
    });
    r = await request(C.port, "POST", "/v1/complete", { body: completeBody({ request_id: "busy-ai-1", timeout_ms: 10000 }) });
    assert(r.status === 504 && r.json.error === "TIMEOUT" && r.json.typed === false && r.json.ambiguous === false,
      "504 says typed:false (and is not ambiguous)");
    assert(/never typed/.test(r.json.message) && /withdrawn/.test(r.json.message), `the 504 message says the prompt was never typed (${r.json.message})`);
    assert(token && token.cancelled === true, "sendToSite got a cancelToken and the bridge cancelled it");
    r = await request(C.port, "GET", "/v1/health");
    assert(r.json.sites.claude.busy === false, "the site is free at once (no late window for an untyped prompt)");
    C.setSend(async (site) => { setTimeout(() => C.bridge.onCaptured({ site, text: "ok [FROM: CLAUDE]", answers: ["0031"] }), 5); return { ok: true, seq: "0031" }; });
    r = await request(C.port, "POST", "/v1/complete", { body: completeBody({ request_id: "busy-ai-2", timeout_ms: 60000 }) });
    assert(r.status === 200 && r.json.seq === "0031", "'Try again' with a NEW request_id goes straight through (no 409)");

    // typing in progress at the timeout: wait for that attempt, then report what really happened
    C.setSend(async (site, text, meta) => { meta.cancelToken.typing = true; await sleep(60); meta.cancelToken.typing = false; return { ok: true, seq: "0032" }; });
    r = await request(C.port, "POST", "/v1/complete", { body: completeBody({ request_id: "typing-1", timeout_ms: 10000 }) });
    assert(r.status === 504 && r.json.typed === true && r.json.seq === "0032" && r.json.ambiguous === true && r.json.late_window_ms === 10000,
      "a timeout while the prompt is being typed waits for it: 504 typed:true with its seq and the late window");
    assert(/typed into claude as \[MSG #0032\]/.test(r.json.message) && /same request_id/.test(r.json.message), "the 504 message says it was typed and how to collect it");
    r = await request(C.port, "POST", "/v1/complete", { body: completeBody({ request_id: "typing-2" }) });
    assert(r.status === 409 && /reserved for the answer/.test(r.json.message) && /typing-1/.test(r.json.message) && /#0032/.test(r.json.message),
      "a different request_id during the late window gets 409 that names the pending request");
    assert(C.bridge.onCaptured({ site: "claude", text: "late [FROM: CLAUDE]", answers: ["0032"] }) === true, "the late answer to #0032 is stored");
    r = await request(C.port, "POST", "/v1/complete", { body: completeBody({ request_id: "typing-1" }) });
    assert(r.status === 200 && r.json.text === "late" && r.json.seq === "0032", "the same request_id collects it");

    // stop() withdraws a queued prompt too
    let stopToken = null;
    C.setSend(async (site, text, meta) => { stopToken = meta.cancelToken; while (!meta.cancelToken.cancelled) await sleep(2); return { ok: false, error: "CANCELLED" }; });
    const pStop = request(C.port, "POST", "/v1/complete", { body: completeBody({ request_id: "stop-1", timeout_ms: 600000 }) });
    await sleep(30);
    await C.bridge.stop();
    r = await pStop.catch(() => ({ status: 0 }));
    assert(stopToken && stopToken.cancelled === true, "stop() cancels a prompt that was not typed yet");
    assert(r.status === 503 && r.json && /the bridge was stopped/.test(r.json.message) && r.json.typed === false,
      `L2: the waiting caller gets 503 "the bridge was stopped" with typed:false, not a reset connection (got ${r.status})`);
  }

  // L2: a prompt already typed when the bridge is turned off: 503 typed:true is delivered
  {
    const T = makeHarness();
    await T.bridge.start();
    T.setSend(async () => ({ ok: true, seq: "0077" }));
    const pTyped = request(T.port, "POST", "/v1/complete", { body: completeBody({ request_id: "stop-typed", timeout_ms: 600000 }) })
      .then((x) => x, (e) => ({ status: 0, code: e.code }));
    await sleep(40);
    const port = T.port;
    await T.bridge.stop();
    const r = await pTyped;
    assert(r.status === 503 && r.json && r.json.error === "SITE_NOT_READY" && r.json.typed === true,
      `L2: stop() with a typed prompt in flight answers 503 typed:true (got ${r.status} ${r.code || ""})`);
    let refused = false;
    try { await request(port, "GET", "/v1/health"); } catch (e) { refused = true; }
    assert(refused, "L2: the port is closed after stop()");
  }

  // --- BF-09: Host check, key before body, pairing not triggerable from a web page ---------
  console.log("HTTP hardening (BF-09)");
  {
    const S9 = makeHarness({ bodyTimeLimitMs: 150 });
    await S9.bridge.start();
    const p9 = S9.port;
    r = await request(p9, "GET", "/v1/health", { headers: { Host: "evil.example" } });
    assert(r.status === 403 && r.json.error === "FORBIDDEN", "Host: evil.example (DNS rebinding) -> 403");
    r = await request(p9, "GET", "/v1/health", { headers: { Host: `evil.example:${p9}` } });
    assert(r.status === 403, "Host: evil.example:<port> -> 403");
    r = await request(p9, "GET", "/v1/health", { headers: { Host: `127.0.0.1:${p9 + 1}` } });
    assert(r.status === 403, "Host 127.0.0.1 with another port -> 403");
    r = await request(p9, "GET", "/v1/health", { headers: { Host: `localhost:${p9}` } });
    assert(r.status === 200, "Host localhost:<port> -> 200");
    r = await request(p9, "GET", "/v1/health", { headers: { Host: "127.0.0.1" } });
    assert(r.status === 200, "Host 127.0.0.1 (no port) -> 200");
    assert(S9.bridge.status().events.some((e) => e.kind === "forbidden_host") && /not addressed to 127\.0\.0\.1/.test(bridgeMod.describeEvent({ kind: "forbidden_host" }).say), "a refused Host is recorded with a plain-English line");

    // the key is checked before the body: a 401 arrives while the body is still outstanding
    const net = require("net");
    const early = await new Promise((resolve) => {
      const sock = net.connect(p9, "127.0.0.1", () => {
        sock.write(`POST /v1/complete HTTP/1.1\r\nHost: 127.0.0.1:${p9}\r\nAuthorization: Bearer wrong\r\nContent-Type: application/json\r\nContent-Length: 500000\r\n\r\n{"site":`);
      });
      let got = "";
      const t = setTimeout(() => { sock.destroy(); resolve(got); }, 2000);
      sock.on("data", (d) => { got += d.toString("utf8"); if (/\r\n\r\n/.test(got)) { clearTimeout(t); sock.destroy(); resolve(got); } });
      sock.on("error", () => {});
    });
    assert(/^HTTP\/1\.1 401/.test(early), `wrong key -> 401 before the (incomplete) body is read (${early.split("\r\n")[0]})`);

    // a body that never finishes arriving is cut off
    const slow = await new Promise((resolve) => {
      const sock = net.connect(p9, "127.0.0.1", () => {
        sock.write(`POST /v1/complete HTTP/1.1\r\nHost: 127.0.0.1:${p9}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"site":`);
      });
      let got = "";
      const t = setTimeout(() => { sock.destroy(); resolve(got); }, 3000);
      sock.on("data", (d) => { got += d.toString("utf8"); });
      sock.on("close", () => { clearTimeout(t); resolve(got); });
      sock.on("error", () => {});
    });
    assert(/^HTTP\/1\.1 408/.test(slow), `a body that stalls past the time limit -> 408 (${slow.split("\r\n")[0] || "no answer"})`);
    assert(S9.sends.length === 0, "nothing was sent for refused requests");

    // pairing: a web page's "simple" POST (text/plain) or any browser Origin is refused and never locks pairing
    const code9 = S9.bridge.createPairingCode();
    for (let i = 0; i < 15; i++) {
      r = await new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify({ code: `WRONGWRONG${String(i).padStart(2, "0")}` }));
        const rq = http.request({ host: "127.0.0.1", port: p9, method: "POST", path: "/v1/pair", agent: false, headers: { "Content-Type": "text/plain;charset=UTF-8", "Content-Length": data.length } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); });
        rq.on("error", reject); rq.end(data);
      });
    }
    assert(r.status === 403, "POST /v1/pair with Content-Type text/plain (a web page's simple request) -> 403");
    r = await request(p9, "POST", "/v1/pair", { token: null, body: { code: "WRONGWRONG99" }, headers: { Origin: "https://evil.example" } });
    assert(r.status === 403, "POST /v1/pair with a browser Origin header -> 403");
    assert(S9.bridge.status().pairing.locked === false, "those refusals never trip the pairing lockout");
    r = await request(p9, "POST", "/v1/pair", { token: null, body: { code: code9, client: "bookforge" } });
    assert(r.status === 200 && r.json.token === TOKEN, "BookForge's own JSON pairing still works afterwards");
    await S9.bridge.stop();
  }

  console.log("stop");
  await H.bridge.stop();
  assert(H.bridge.status().listening === false, "status() not listening after stop");
  let refused = false;
  try { await request(port, "GET", "/v1/health"); } catch (e) { refused = e.code === "ECONNREFUSED"; if (!refused) console.log("    got", e.code); }
  assert(refused, "connection refused once stopped");

  // --- contract v1.1: pairing ----------------------------------------------------
  console.log("pairing (contract v1.1)");
  {
    let clock = 1_000_000;
    const logs = [];
    const P = bridgeMod.createBridge({ port: 0, getToken: () => TOKEN, sendToSite: async () => ({ ok: true }), now: () => clock, logger: (k, d) => logs.push(JSON.stringify({ k, d })) });
    await P.start();
    const pp = P.status().port;
    const pair = (body, extra = {}) => request(pp, "POST", "/v1/pair", Object.assign({ token: null, body }, extra));
    assert(typeof P.createPairingCode === "function", "createPairingCode() is exposed");
    let res = await pair({ code: "AAAAAAAAAAAA", client: "bookforge" });
    assert(res.status === 401 && res.json.ok === false && res.json.error === "PAIRING_CODE_INVALID", "no code made yet -> 401 PAIRING_CODE_INVALID");
    const code = P.createPairingCode();
    assert(/^[A-Za-z0-9]{12}$/.test(code), `pairing code is 12 chars of [A-Za-z0-9] (${code.length})`);
    const codes = new Set(); for (let i = 0; i < 50; i++) codes.add(bridgeMod.generatePairingCode());
    assert(codes.size === 50, "pairing codes are random (50 distinct)");
    assert(P.status().pairing.pending === true && !JSON.stringify(P.status()).includes(code), "status() says a code is pending but never shows the code");
    res = await pair({ code: code.toLowerCase() === code ? code.toUpperCase() : code.toLowerCase(), client: "bookforge" });
    assert(res.status === 401 && res.json.error === "PAIRING_CODE_INVALID", "wrong code (case matters) -> 401");
    res = await pair({ code, client: "bookforge" });
    assert(res.status === 200 && res.json.ok === true && res.json.token === TOKEN && res.json.bridge_version === "1.2", "right code, no Authorization header -> 200 with the connection key + bridge_version 1.2");
    res = await pair({ code, client: "bookforge" });
    assert(res.status === 401 && res.json.error === "PAIRING_CODE_INVALID" && !res.text.includes(TOKEN), "a code works only once (second use -> 401, no key)");
    assert(P.status().pairing.pending === false && P.status().pairing.lastPairedAt === clock, "status() records when pairing happened");
    const c1 = P.createPairingCode();
    const c2 = P.createPairingCode();
    res = await pair({ code: c1 });
    assert(res.status === 401, "making a new code invalidates the older unused one");
    clock += bridgeMod.PAIR_CODE_TTL_MS + 1;
    res = await pair({ code: c2 });
    assert(res.status === 410 && res.json.error === "PAIRING_CODE_EXPIRED", "expired code (after 120 s) -> 410 PAIRING_CODE_EXPIRED");
    const c3 = P.createPairingCode();
    clock += bridgeMod.PAIR_CODE_TTL_MS - 1000;
    res = await pair({ code: c3, client: "bookforge" });
    assert(res.status === 200 && res.json.token === TOKEN, "a code still works just before 120 s");
    for (const [extra, what] of [[{ rawBody: Buffer.from("nope") }, "non-JSON"], [{ body: [1] }, "array"], [{ body: {} }, "missing code"], [{ body: { code: 123 } }, "numeric code"], [{ body: { code: "x", client: 5 } }, "non-string client"]]) {
      res = await request(pp, "POST", "/v1/pair", Object.assign({ token: null }, extra));
      assert(res.status === 400 && res.json.error === "BAD_REQUEST", `bad pair body (${what}) -> 400`);
    }
    // rate limit: 10 failures inside 60 s -> 429 for 60 s, even for a valid code
    clock += 61000; // fresh window
    const c4 = P.createPairingCode();
    let statuses = [];
    for (let i = 0; i < 10; i++) { res = await pair({ code: `WRONGWRONG${String(i).padStart(2, "0")}` }); statuses.push(res.status); }
    assert(statuses.every((x) => x === 401), "10 wrong codes -> each 401");
    res = await pair({ code: c4 });
    assert(res.status === 429 && res.json.error === "TOO_MANY_ATTEMPTS" && !res.text.includes(TOKEN), "11th attempt (even with the right code) -> 429 TOO_MANY_ATTEMPTS");
    assert(P.status().pairing.locked === true, "status() shows pairing is paused");
    clock += bridgeMod.PAIR_LOCK_MS + 1;
    const c5 = P.createPairingCode();
    res = await pair({ code: c5 });
    assert(res.status === 200 && res.json.token === TOKEN, "after 60 s pairing works again");
    const evs = P.status().events.filter((e) => e.kind === "pair");
    assert(evs.length >= 5 && evs.some((e) => e.outcome === "PAIRED" && e.http_status === 200) && evs.some((e) => e.outcome === "PAIRING_CODE_EXPIRED" && e.http_status === 410) && evs.some((e) => e.outcome === "TOO_MANY_ATTEMPTS" && e.http_status === 429), "pair events (outcome only) are in the activity ring");
    const dump = JSON.stringify(P.status()) + logs.join("\n");
    assert(![code, c1, c2, c3, c4, c5].some((c) => dump.includes(c)) && !dump.includes(TOKEN) && !dump.includes("WRONGWRONG"), "codes, presented codes and the key never appear in status/events/logs");
    assert(/Made a one-time pairing code/.test(bridgeMod.describeEvent({ kind: "pair_code" }).say) && /paired/.test(bridgeMod.describeEvent({ kind: "pair", outcome: "PAIRED" }).say) && bridgeMod.describeEvent({ kind: "pair", outcome: "TOO_MANY_ATTEMPTS" }).tone === "warn", "pair events have plain-English lines");
    res = await request(pp, "GET", "/v1/pair", { token: null });
    assert(res.status === 401, "GET /v1/pair is not the pairing endpoint (needs a key -> 401)");
    // No key yet -> 503 NOT_READY, code not consumed
    let tok = "";
    const Q = bridgeMod.createBridge({ port: 0, getToken: () => tok, sendToSite: async () => ({ ok: true }) });
    await Q.start();
    const qc = Q.createPairingCode();
    res = await request(Q.status().port, "POST", "/v1/pair", { token: null, body: { code: qc } });
    assert(res.status === 503 && res.json.error === "NOT_READY", "no connection key yet -> 503 NOT_READY");
    tok = TOKEN;
    res = await request(Q.status().port, "POST", "/v1/pair", { token: null, body: { code: qc } });
    assert(res.status === 200 && res.json.token === TOKEN, "...and the code is not used up by that");
    await Q.stop();
    await P.stop();
  }

  // --- contract v1.1: status from BookForge ----------------------------------------
  console.log("status from BookForge (contract v1.1)");
  {
    let clock = 5_000_000;
    const S = bridgeMod.createBridge({ port: 0, getToken: () => TOKEN, sendToSite: async () => ({ ok: true }), now: () => clock });
    await S.start();
    const sp = S.status().port;
    const SECRET_TITLE = "Chapter about TOPSECRET-TITLE-q1";
    const good = {
      app: "bookforge", version: 1, bookforge_url: "http://127.0.0.1:8780/",
      project: { id: "p-1", title: "The Lantern Keeper" },
      current_task: { set: "B", op: "B03", title: "Main plot", state: "running", message: "Writing the main plot with Claude", url: "http://127.0.0.1:8780/#/op/B03" },
      working_on: { op: "B03", title: SECRET_TITLE, started_at: "2026-10-17T10:00:00Z" },
      approvals: { count: 2, items: [{ op: "B01", set: "B", title: "Premise" }, { op: "B02", set: "B", title: "Logline" }], url: "http://localhost:8780/#/approvals" },
      checklist: [{ id: "A", title: "Book profile", set: "A", state: "done" }, { id: "B", title: "Story bible", set: "B", state: "current" }],
      done: 1, total: 9, updated_at: 1792231200
    };
    assert(S.status().bookforge === null && S.bookforgeStatus() === null, "status().bookforge is null before BookForge reports");
    let res = await request(sp, "POST", "/v1/status", { token: null, body: good });
    assert(res.status === 401, "POST /v1/status without the key -> 401");
    res = await request(sp, "POST", "/v1/status", { body: good });
    assert(res.status === 200 && res.json.ok === true, "POST /v1/status with the key -> 200 {ok:true}");
    let b = S.status().bookforge;
    assert(b && b.project.title === "The Lantern Keeper" && b.current_task.op === "B03" && b.current_task.set === "B" && b.approvals.count === 2 && b.approvals.items.length === 2 && b.checklist.length === 2 && b.done === 1 && b.total === 9, "latest status is exposed as status().bookforge");
    assert(b.receivedAt === clock && b.stale === false && b.age_ms === 0, "status carries receivedAt and stale:false while fresh");
    assert(b.working_on.started_at === Date.parse("2026-10-17T10:00:00Z") && b.updated_at === 1792231200000, "started_at / updated_at normalised to epoch ms (ISO or seconds)");
    assert(typeof S.status().lastExternalContactAt === "number", "a status report counts as contact from BookForge");
    // sanitising
    const evil = JSON.parse(JSON.stringify(good));
    evil.extra_field = "nope";
    evil.project.title = "T".repeat(500);
    evil.current_task.message = "M".repeat(2000);
    evil.current_task.url = "https://evil.example/";
    evil.current_task.extra = "x";
    evil.approvals.url = "javascript:alert(1)";
    evil.approvals.items = Array.from({ length: 50 }, (_, i) => ({ op: `X${i}`, title: "t", junk: 1 }));
    evil.checklist = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, title: "row", set: "C", state: "todo" }));
    evil.bookforge_url = "http://192.168.1.5:8780/";
    res = await request(sp, "POST", "/v1/status", { body: evil });
    b = S.status().bookforge;
    assert(res.status === 200 && !("extra_field" in b) && !("extra" in b.current_task) && !("junk" in b.approvals.items[0]), "unknown fields are dropped (whitelist)");
    assert(b.project.title.length === 200 && b.current_task.message.length === 500, "titles capped at 200 chars, message at 500");
    assert(b.approvals.items.length === 20 && b.checklist.length === 40, "approval items capped at 20, checklist at 40");
    assert(b.current_task.url === null && b.approvals.url === null && b.bookforge_url === null, "non-loopback / non-http URLs are dropped");
    res = await request(sp, "POST", "/v1/status", { body: Object.assign({}, good, { current_task: Object.assign({}, good.current_task, { url: "http://localhost:8780/#/op/B03" }) }) });
    assert(S.status().bookforge.current_task.url === "http://localhost:8780/#/op/B03", "http://localhost URLs are kept");
    for (const [extra, what] of [[{ rawBody: Buffer.from("{bad") }, "non-JSON"], [{ body: [1] }, "array"], [{ body: { app: "other" } }, "app not bookforge"]]) {
      res = await request(sp, "POST", "/v1/status", extra);
      assert(res.status === 400 && res.json.error === "BAD_REQUEST", `bad status body (${what}) -> 400`);
    }
    const big = Object.assign({}, good, { pad: "x".repeat(bridgeMod.MAX_STATUS_BYTES + 10) });
    res = await request(sp, "POST", "/v1/status", { body: big });
    assert(res.status === 413 && res.json.error === "TOO_LARGE", "status body over 32 KiB -> 413");
    assert(S.status().bookforge.current_task.url === "http://localhost:8780/#/op/B03", "a rejected status leaves the last good one in place");
    // staleness
    clock += bridgeMod.BF_STATUS_STALE_MS + 5000;
    b = S.status().bookforge;
    assert(b && b.stale === true && b.age_ms === bridgeMod.BF_STATUS_STALE_MS + 5000, "after 90 s without an update the status is marked stale:true (kept, with its age)");
    res = await request(sp, "POST", "/v1/status", { body: good });
    assert(S.status().bookforge.stale === false, "a new report makes it fresh again");
    // activity: only "status received", never the content
    const sev = S.status().events.filter((e) => e.kind === "status");
    assert(sev.length === 2, `"status received" is recorded only on the first report and after a gap (${sev.length})`);
    const evDump = JSON.stringify(S.status().events);
    assert(!evDump.includes("Lantern") && !evDump.includes("TOPSECRET-TITLE") && !evDump.includes("Main plot"), "status content never goes into the activity ring");
    assert(S.status().counters.status_updates >= 4, "status updates are counted");
    assert(/BookForge sent an update/.test(bridgeMod.describeEvent({ kind: "status" }).say), "status events have a plain-English line");
    // Health and complete still behave as v1
    res = await request(sp, "GET", "/v1/health");
    assert(res.status === 200 && res.json.sites && res.json.sites.claude, "v1 /v1/health unchanged");
    await S.stop();
  }

  console.log("fake-bridge-host fixture (CLI, separate process)");
  {
    const { spawn } = require("child_process");
    const hostPath = path.join(__dirname, "fixtures", "fake-bridge-host.js");
    const spawnHost = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hostPath, "--port", "0", "--token", TOKEN, "--delay-ms", "5", ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const t = setTimeout(() => reject(new Error("host did not print READY")), 10000);
      child.stdout.on("data", (c) => {
        out += c;
        const m = /^READY (\d+)\n/.exec(out);
        if (m) { clearTimeout(t); resolve({ child, port: Number(m[1]) }); }
      });
      child.on("exit", (code) => reject(new Error(`host exited ${code}`)));
    });
    const kill = (child) => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); });
    const schema = {
      type: "object",
      required: ["title", "count", "ok", "tags", "parts", "kind", "meta", "maybe"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        count: { type: "integer", minimum: 3 },
        ok: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        parts: { type: "array", minItems: 1, items: { $ref: "#/$defs/part" } },
        kind: { enum: ["alpha", "beta"] },
        meta: { type: "object", required: ["n"], properties: { n: { type: "number" }, skip: { type: "string" } } },
        maybe: { type: ["string", "null"] }
      },
      $defs: { part: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }
    };
    const schemaPrompt = `Answer with one JSON object.\nJSON_SCHEMA:\n${JSON.stringify(schema, null, 2)}\nEND_JSON_SCHEMA\nThanks.`;
    const parseFence = (t) => { const m = /```json\n([\s\S]*?)\n```/.exec(t || ""); return m ? JSON.parse(m[1]) : null; };

    let h = await spawnHost(["--mode", "valid"]);
    r = await request(h.port, "POST", "/v1/complete", { body: { site: "gemini", prompt: schemaPrompt, request_id: "fh-1", timeout_ms: 10000 } });
    const obj = r.status === 200 ? parseFence(r.json.text) : null;
    assert(r.status === 200 && obj, "fake host (valid) answers 200 with a ```json fence");
    assert(obj && obj.title === "sample title" && obj.count === 3 && obj.ok === true && Array.isArray(obj.tags) && obj.tags.length === 0, "sample: strings/integers(min)/booleans/arrays(minItems 0)");
    assert(obj && obj.parts.length === 1 && obj.parts[0].name === "sample name" && obj.kind === "alpha" && obj.meta.n === 1 && !("skip" in obj.meta) && obj.maybe === null, "sample: $ref items, enum first, nested required only, nullable -> null");
    assert(r.json && !/\[FROM:/.test(r.json.text), "fake host reply arrives envelope-stripped");
    await kill(h.child);

    h = await spawnHost(["--mode", "invalid-then-valid"]);
    r = await request(h.port, "POST", "/v1/complete", { body: { site: "claude", prompt: schemaPrompt, request_id: "fh-2a", timeout_ms: 10000 } });
    const first = parseFence(r.json && r.json.text);
    r = await request(h.port, "POST", "/v1/complete", { body: { site: "claude", prompt: schemaPrompt, request_id: "fh-2b", timeout_ms: 10000 } });
    const second = parseFence(r.json && r.json.text);
    assert(first && first.invalid_sample === true && second && second.title === "sample title", "invalid-then-valid: first reply invalid, re-ask valid");
    await kill(h.child);

    h = await spawnHost(["--mode", "timeout", "--time-scale", "0.005"]);
    r = await request(h.port, "POST", "/v1/complete", { body: { site: "chatgpt", prompt: "x", request_id: "fh-3", timeout_ms: 10000 } });
    assert(r.status === 504 && r.json.ambiguous === true, "timeout mode -> 504 TIMEOUT ambiguous");
    await kill(h.child);

    h = await spawnHost(["--mode", "busy", "--not-ready", "gemini"]);
    r = await request(h.port, "POST", "/v1/complete", { body: { site: "claude", prompt: "x", request_id: "fh-4", timeout_ms: 10000 } });
    assert(r.status === 409 && r.json.error === "SITE_BUSY", "busy mode -> 409 SITE_BUSY");
    r = await request(h.port, "GET", "/v1/health");
    assert(r.json.sites.gemini.ready === false, "--not-ready reflected in health");
    await kill(h.child);

    // contract v1.1 helpers for cross-process tests
    const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), "bf-fh-"));
    const codeFile = path.join(tmpd, "code.txt");
    const statusFile = path.join(tmpd, "status.json");
    h = await spawnHost(["--pairing-code-file", codeFile, "--status-file", statusFile]);
    const fhCode = fs.readFileSync(codeFile, "utf8");
    assert(/^[A-Za-z0-9]{12}$/.test(fhCode), "--pairing-code-file writes a 12-char pairing code before READY");
    r = await request(h.port, "POST", "/v1/pair", { token: null, body: { code: fhCode, client: "bookforge" } });
    assert(r.status === 200 && r.json.token === TOKEN, "fake host: /v1/pair with that code returns the key");
    r = await request(h.port, "POST", "/v1/status", { body: { app: "bookforge", version: 1, done: 2, total: 5, checklist: [] } });
    let wrote = null;
    for (let i = 0; i < 60 && !wrote; i++) { await sleep(25); try { wrote = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch (_) {} }
    assert(r.status === 200 && wrote && wrote.done === 2 && wrote.total === 5, "--status-file receives the sanitized status");
    await kill(h.child);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
