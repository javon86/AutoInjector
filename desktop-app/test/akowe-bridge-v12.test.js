// test/akowe-bridge-v12.test.js — contract v1.2 of the Akọwe bridge
// (docs/AKOWE_AUTOINJECTOR_BRIDGE.md): self-repair states in GET /v1/health,
// POST /v1/probe, 503 SITE_NOT_READY {state, problem} for an AI that is being
// repaired / needs the user / is broken, plus the P18.5 bridge-side fix (a reply
// captured while the prompt's send is still being confirmed is owned by number).
// Also the fake host's --site-state option. Pure Node, the REAL akowe-bridge.js.
// Run with: node test/akowe-bridge-v12.test.js
"use strict";
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const bridgeMod = require("../akowe-bridge");
const { startFakeHost, parseSiteStates } = require("./fixtures/fake-bridge-host");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "v12-token-abcdefghijklmnopqrstuvwxyz-0123";
function request(port, method, urlPath, { token = TOKEN, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // ---------------------------------------------------------------------------------
  console.log("== GET /v1/health: state, problem, since, last_probe_ok_at per AI ==");
  const states = { chatgpt: { state: "ok", problem: null, since: 1000, last_probe_ok_at: 2000 }, claude: { state: "needs_user", problem: "LOGGED_OUT", since: 3000, last_probe_ok_at: null }, gemini: null };
  const probeCalls = [];
  let probeImpl = (want) => { const w = want || ["chatgpt", "claude", "gemini"]; return { started: w.filter((s) => s !== "gemini"), skipped: w.includes("gemini") ? { gemini: "typing" } : {} }; };
  const sends = [];
  const events = [];
  const bridge = bridgeMod.createBridge({
    port: 0, getToken: () => TOKEN, siteReady: () => true, timeScale: 0.002,
    siteState: (s) => states[s],
    startProbe: (want) => { probeCalls.push(want); return probeImpl(want); },
    sendToSite: (site, text, meta) => { sends.push({ site, text, meta }); return new Promise(() => {}); },
    onEvent: (e) => events.push(e)
  });
  await bridge.start();
  const port = bridge.status().port;
  let r = await request(port, "GET", "/v1/health");
  assert(r.status === 200 && r.json.bridge_version === "1.2", "bridge_version 1.2");
  const S = r.json.sites;
  assert(S.chatgpt.ready === true && S.chatgpt.busy === false && S.chatgpt.state === "ok" && S.chatgpt.problem === null && S.chatgpt.since === 1000 && S.chatgpt.last_probe_ok_at === 2000, "ok AI: ready true + the four new fields");
  assert(S.claude.ready === false && S.claude.state === "needs_user" && S.claude.problem === "LOGGED_OUT" && S.claude.since === 3000 && S.claude.last_probe_ok_at === null, "needs_user AI: ready false, problem and since");
  assert(S.gemini.ready === true && S.gemini.state === "unknown" && S.gemini.problem === null && S.gemini.since === null && S.gemini.last_probe_ok_at === null, "no state yet -> 'unknown', ready stays as before");
  states.gemini = { state: "repairing", problem: "NO_REPLY_FOUND", since: 5 };
  states.chatgpt = { state: "weird", problem: "lower case <script>", since: -4, last_probe_ok_at: "x" };
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.gemini.ready === false && r.json.sites.gemini.state === "repairing", "repairing -> ready false");
  assert(r.json.sites.chatgpt.state === "unknown" && r.json.sites.chatgpt.problem === null && r.json.sites.chatgpt.since === null && r.json.sites.chatgpt.last_probe_ok_at === null, "malformed states are cleaned (unknown / null), never passed through");
  states.chatgpt = { state: "broken", problem: "TYPE_FAILED", since: 7 };
  r = await request(port, "GET", "/v1/health");
  assert(r.json.sites.chatgpt.ready === false && r.json.sites.chatgpt.state === "broken", "broken -> ready false");

  // ---------------------------------------------------------------------------------
  console.log("== POST /v1/complete to an AI that isn't usable -> 503 SITE_NOT_READY {state, problem} ==");
  for (const [site, st, prob] of [["claude", "needs_user", "LOGGED_OUT"], ["gemini", "repairing", "NO_REPLY_FOUND"], ["chatgpt", "broken", "TYPE_FAILED"]]) {
    r = await request(port, "POST", "/v1/complete", { body: { site, prompt: "hello there", request_id: `v12-${site}`, timeout_ms: 10000 } });
    assert(r.status === 503 && r.json.error === "SITE_NOT_READY" && r.json.state === st && r.json.problem === prob && r.json.ambiguous === false && /another AI/.test(r.json.message), `${site} ${st} -> 503 with state + problem (${r.json && r.json.message})`);
  }
  assert(sends.length === 0, "nothing was sent to those AIs");
  states.chatgpt = { state: "ok" };
  r = await request(port, "POST", "/v1/complete", { body: { site: "chatgpt", prompt: "hello", request_id: "v12-ok", timeout_ms: 10000 } });
  assert(sends.length === 1 && sends[0].site === "chatgpt", "an ok AI still takes the prompt (v1 behaviour unchanged)");
  assert(r.status === 504, "(and times out normally here)");

  // ---------------------------------------------------------------------------------
  console.log("== POST /v1/probe ==");
  r = await request(port, "POST", "/v1/probe", { token: null, body: {} });
  assert(r.status === 401, "needs the key (401 without it)");
  r = await request(port, "POST", "/v1/probe", { body: { sites: ["chatgpt", "claude"] } });
  assert(r.status === 202 && r.json.ok === true && JSON.stringify(r.json.started) === '["chatgpt","claude"]' && JSON.stringify(r.json.skipped) === "{}", `202 {ok, started, skipped} (${r.text})`);
  assert(JSON.stringify(probeCalls[probeCalls.length - 1]) === '["chatgpt","claude"]', "the requested AIs are passed on");
  r = await request(port, "POST", "/v1/probe", { raw: "" });
  assert(r.status === 202 && probeCalls[probeCalls.length - 1] === null && r.json.skipped.gemini === "typing", "empty body -> every active AI (null), skipped reasons come back");
  r = await request(port, "POST", "/v1/probe", { body: {} });
  assert(r.status === 202 && probeCalls[probeCalls.length - 1] === null, "{} -> every active AI");
  r = await request(port, "POST", "/v1/probe", { body: { sites: ["claude", "claude"] } });
  assert(r.status === 202 && JSON.stringify(probeCalls[probeCalls.length - 1]) === '["claude"]', "duplicates collapsed");
  r = await request(port, "POST", "/v1/probe", { body: { sites: ["bard"] } });
  assert(r.status === 404 && r.json.error === "UNKNOWN_SITE", "unknown site -> 404 UNKNOWN_SITE");
  r = await request(port, "POST", "/v1/probe", { body: { sites: "claude" } });
  assert(r.status === 400 && r.json.error === "BAD_REQUEST", "sites not a list -> 400");
  r = await request(port, "POST", "/v1/probe", { raw: "{not json" });
  assert(r.status === 400, "not JSON -> 400");
  r = await request(port, "POST", "/v1/probe", { raw: "[1]" });
  assert(r.status === 400, "not an object -> 400");
  r = await request(port, "POST", "/v1/probe", { raw: JSON.stringify({ sites: ["x".repeat(5000)] }) });
  assert(r.status === 413, "a body over 4 KiB -> 413");
  probeImpl = () => ({ started: ["claude", "nope"], skipped: { gemini: "SOMETHING <b>odd</b>", chatgpt: "busy", zz: "x" } });
  r = await request(port, "POST", "/v1/probe", { body: {} });
  assert(JSON.stringify(r.json.started) === '["claude"]' && r.json.skipped.gemini === "busy" && r.json.skipped.chatgpt === "busy" && !("zz" in r.json.skipped), "what the host returns is cleaned (known sites, known reasons)");
  probeImpl = () => { throw new Error("boom"); };
  r = await request(port, "POST", "/v1/probe", { body: {} });
  assert(r.status === 202 && r.json.started.length === 0 && Object.values(r.json.skipped).every((x) => x === "unsupported"), "a host that throws -> nothing started, 'unsupported'");
  const st = bridge.status();
  assert(st.counters.probes === 6, "probe requests are counted");
  const pe = events.filter((e) => e.kind === "probe");
  assert(pe.length && pe.every((e) => e.site && (e.outcome === "STARTED" || e.outcome === "SKIPPED") && e.http_status === 202), "each started/skipped AI is an activity event");
  assert(/check-in of Claude/.test(bridgeMod.describeEvent({ kind: "probe", site: "claude", outcome: "STARTED" }, () => "Claude").say), "plain-English activity line");
  await bridge.stop();
  // a v1.1 host (no siteState / startProbe): health says "unknown", probe says "unsupported"
  const old = bridgeMod.createBridge({ port: 0, getToken: () => TOKEN, sendToSite: async () => ({ ok: true, seq: "0001" }) });
  await old.start();
  r = await request(old.status().port, "GET", "/v1/health");
  assert(r.json.sites.claude.state === "unknown" && r.json.sites.claude.ready === true, "host without self-repair: state unknown, ready unchanged");
  r = await request(old.status().port, "POST", "/v1/probe", { body: { sites: ["claude"] } });
  assert(r.status === 202 && r.json.skipped.claude === "unsupported" && r.json.started.length === 0, "host without self-repair: probe -> skipped 'unsupported'");
  await old.stop();

  // ---------------------------------------------------------------------------------
  console.log("== P18.5: a reply captured while the send is still being confirmed ==");
  {
    let resolveSend;
    const b = bridgeMod.createBridge({
      port: 0, getToken: () => TOKEN, timeScale: 0.01,
      sendToSite: (site, text, meta) => { meta.cancelToken.seq = "0042"; return new Promise((res) => { resolveSend = res; }); }
    });
    await b.start();
    const p = request(b.status().port, "POST", "/v1/complete", { body: { site: "gemini", prompt: "the prompt", request_id: "gem-1", timeout_ms: 10000 } });
    await sleep(80);
    // The exact Gemini case from the first real run: the answer was on the page (and
    // captured) while the send script was still retrying SEND_NOT_CONFIRMED.
    const GEMINI_TEXT = "[TO: USER]\n\nJSON\n{\"ok\": true, \"site\": \"gemini\", \"word\": \"tundra\"}\n\n\n[FROM: GEMINI]";
    assert(b.onCaptured({ site: "gemini", text: "an older reply", answers: ["0041"] }) === false, "a reply to an older message is not taken");
    assert(b.onCaptured({ site: "gemini", text: GEMINI_TEXT, answers: ["0042"] }) === true, "the reply that answers #0042 is owned although the send hasn't confirmed yet");
    resolveSend({ ok: true, seq: "0042" });
    r = await p;
    assert(r.status === 200 && r.json.seq === "0042" && r.json.reply_to === "0042" && /"word": "tundra"/.test(r.json.text) && !/\[FROM:/.test(r.json.text), `200 with the answer, seq == reply_to (${r.status} ${r.json && r.json.error})`);
    await b.stop();
  }
  {
    // no seq on the token (older host): the declined reply is remembered and collected once the send confirms
    let resolveSend;
    const b = bridgeMod.createBridge({ port: 0, getToken: () => TOKEN, timeScale: 0.01, sendToSite: () => new Promise((res) => { resolveSend = res; }) });
    await b.start();
    const p = request(b.status().port, "POST", "/v1/complete", { body: { site: "claude", prompt: "x", request_id: "cl-1", timeout_ms: 10000 } });
    await sleep(60);
    assert(b.onCaptured({ site: "claude", text: "early answer", answers: ["0077"] }) === false, "without a known number it can't be taken yet");
    resolveSend({ ok: true, seq: "0077" });
    r = await p;
    assert(r.status === 504 || r.status === 200, "(older host path)");
    await b.stop();
  }
  {
    let resolveSend;
    const b = bridgeMod.createBridge({ port: 0, getToken: () => TOKEN, timeScale: 0.01, sendToSite: () => new Promise((res) => { resolveSend = res; }) });
    await b.start();
    const p = request(b.status().port, "POST", "/v1/complete", { body: { site: "claude", prompt: "x", request_id: "cl-2", timeout_ms: 10000 } });
    await sleep(60);
    resolveSend({ ok: true, seq: "0090" });
    await sleep(20);
    assert(b.onCaptured({ site: "claude", text: "answer to the user's side question", answers: ["0089"] }) === false, "typed: a reply to another message is declined (remembered briefly)");
    assert(b.onCaptured({ site: "claude", text: "[TO: USER]\nthe real answer\n[FROM: CLAUDE]", answers: ["0089", "0090"] }) === true, "a reply that answers it (batched) is owned");
    r = await p;
    assert(r.status === 200 && r.json.text === "the real answer", "200 with the stripped answer");
    await b.stop();
  }

  // ---------------------------------------------------------------------------------
  console.log("== fake host: --site-state and /v1/probe ==");
  assert(JSON.stringify(parseSiteStates("chatgpt=needs_user:LOGGED_OUT,gemini=repairing")) === JSON.stringify({ chatgpt: { state: "needs_user", problem: "LOGGED_OUT" }, gemini: { state: "repairing", problem: null } }), "parseSiteStates");
  let threw = false; try { parseSiteStates("chatgpt=sleepy"); } catch (_) { threw = true; }
  assert(threw, "a bad --site-state entry is refused");
  const host = await startFakeHost({ port: 0, token: TOKEN, delayMs: 20, siteStates: { chatgpt: { state: "needs_user", problem: "USAGE_LIMIT" } } });
  r = await request(host.port, "GET", "/v1/health");
  assert(r.json.sites.chatgpt.state === "needs_user" && r.json.sites.chatgpt.problem === "USAGE_LIMIT" && r.json.sites.chatgpt.ready === false && r.json.sites.claude.state === "unknown", "pinned state shows in health");
  r = await request(host.port, "POST", "/v1/complete", { body: { site: "chatgpt", prompt: "x", request_id: "h-1", timeout_ms: 10000 } });
  assert(r.status === 503 && r.json.state === "needs_user" && r.json.problem === "USAGE_LIMIT", "pinned state -> 503 with state/problem");
  r = await request(host.port, "POST", "/v1/probe", { body: {} });
  assert(r.status === 202 && r.json.started.length === 3, "probe starts all three");
  await sleep(80);
  r = await request(host.port, "GET", "/v1/health");
  assert(r.json.sites.claude.state === "ok" && typeof r.json.sites.claude.last_probe_ok_at === "number" && r.json.sites.chatgpt.state === "needs_user", "unpinned AIs become ok after a check-in; the pinned one stays");
  host.clearSiteStates();
  r = await request(host.port, "GET", "/v1/health");
  assert(r.json.sites.chatgpt.state === "ok" && r.json.sites.chatgpt.ready === true, "clearing the pins (SIGUSR1 in CLI mode) -> ok");
  await host.stop();
  if (process.platform !== "win32") {
    const child = spawn(process.execPath, [path.join(__dirname, "fixtures", "fake-bridge-host.js"), "--port", "0", "--token", TOKEN, "--site-state", "gemini=broken:TYPE_FAILED"], { stdio: ["ignore", "pipe", "pipe"] });
    const port2 = await new Promise((resolve) => { let buf = ""; child.stdout.on("data", (d) => { buf += d; const m = /READY (\d+)/.exec(buf); if (m) resolve(Number(m[1])); }); setTimeout(() => resolve(null), 8000); });
    r = await request(port2, "GET", "/v1/health");
    assert(r.json.sites.gemini.state === "broken" && r.json.sites.gemini.problem === "TYPE_FAILED", "CLI --site-state works");
    child.kill("SIGUSR1");
    await sleep(150);
    r = await request(port2, "GET", "/v1/health");
    assert(r.json.sites.gemini.state === "ok", "CLI: SIGUSR1 clears the pinned states");
    child.kill("SIGTERM");
  }
}

main().then(() => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
