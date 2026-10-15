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
  assert(r.status === 200 && r.json.ok === true && r.json.bridge_version === "1", "health 200 with bridge_version 1");
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

  console.log("stop");
  await H.bridge.stop();
  assert(H.bridge.status().listening === false, "status() not listening after stop");
  let refused = false;
  try { await request(port, "GET", "/v1/health"); } catch (e) { refused = e.code === "ECONNREFUSED"; if (!refused) console.log("    got", e.code); }
  assert(refused, "connection refused once stopped");

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
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
