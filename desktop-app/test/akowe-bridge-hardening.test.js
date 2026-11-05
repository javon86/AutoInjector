// test/akowe-bridge-hardening.test.js — the final hardening pass of the Akọwe bridge (PR #123, backward compatible):
//   * limit_reset_at: a usage-limit notice that names a time is passed on to Akọwe (503 SITE_ERROR rate-limit and
//     the site's /v1/health entry), so a run that waits for the limits resumes at the right time;
//   * followup / followup_of: a short correction is typed into the SAME chat as the request it corrects — only when
//     that chat is still the current one — else 409 FOLLOWUP_UNAVAILABLE and nothing is typed.
// Pure Node, the REAL akowe-bridge.js. Run with: node test/akowe-bridge-hardening.test.js
"use strict";
const http = require("http");
const bridgeMod = require("../akowe-bridge");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "hard-token-abcdefghijklmnopqrstuvwxyz-0123";
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Authorization: `Bearer ${TOKEN}` };
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const text = Buffer.concat(c).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// A host whose sends are typed at once with increasing [MSG #] numbers; the test answers them with onCaptured().
function makeHost(extra) {
  const sends = [];
  let seq = 100;
  const opts = Object.assign({
    port: 0, getToken: () => TOKEN, siteReady: () => true, timeScale: 1,
    sendToSite: (site, text, meta) => { const s = String(++seq); sends.push({ site, text, meta, seq: s }); return Promise.resolve({ ok: true, seq: s }); }
  }, extra || {});
  const bridge = bridgeMod.createBridge(opts);
  return { bridge, sends };
}
async function answer(bridge, sends, site, text, extra) {
  for (let i = 0; i < 100 && !(sends.length && sends[sends.length - 1].site === site && bridge.awaitingReply(site)); i++) await sleep(5);
  const last = sends[sends.length - 1];
  return bridge.onCaptured(Object.assign({ site, text, answers: [last.seq] }, extra || {}));
}

async function main() {
  console.log("== limit_reset_at: the reset time the site showed goes to Akọwe ==");
  {
    const reset = Date.now() + 2 * 3600 * 1000;
    const states = { chatgpt: null, claude: null, gemini: null };
    const { bridge, sends } = makeHost({ siteState: (s) => states[s] });
    await bridge.start();
    const port = bridge.status().port;
    const p = request(port, "POST", "/v1/complete", { site: "claude", prompt: "write chapter 3", request_id: "lim-1", timeout_ms: 10000 });
    assert(await answer(bridge, sends, "claude", "You are out of free messages until 3:40 PM", { siteError: "rate-limit", limitResetAt: reset }), "the usage-limit notice answers the request");
    const r = await p;
    assert(r.status === 503 && r.json.error === "SITE_ERROR" && r.json.site_error === "rate-limit", "503 SITE_ERROR rate-limit, as before");
    assert(r.json.limit_reset_at === new Date(reset).toISOString(), `…with limit_reset_at (ISO 8601): ${r.json.limit_reset_at}`);
    let h = await request(port, "GET", "/v1/health");
    assert(h.json.sites.claude.limit_reset_at === new Date(reset).toISOString(), "/v1/health shows it for that AI while it is ahead");
    assert(!("limit_reset_at" in h.json.sites.chatgpt) && !("limit_reset_at" in h.json.sites.gemini), "…and not for the other AIs");
    // self-repair saw the notice on the page (siteState): the earlier of the two is given
    const sooner = Date.now() + 30 * 60 * 1000;
    states.gemini = { state: "needs_user", problem: "USAGE_LIMIT", since: 5, limit_reset_at: sooner };
    h = await request(port, "GET", "/v1/health");
    assert(h.json.sites.gemini.limit_reset_at === new Date(sooner).toISOString() && h.json.sites.gemini.state === "needs_user", "a reset time self-repair read from the page shows too");
    states.gemini = { state: "needs_user", problem: "USAGE_LIMIT", since: 5, limit_reset_at: Date.now() - 1000 };
    h = await request(port, "GET", "/v1/health");
    assert(!("limit_reset_at" in h.json.sites.gemini), "a reset time already past is never given");
    bridge.noteLimitReset("chatgpt", Date.now() + 60000);
    bridge.noteLimitReset("chatgpt", "nonsense");
    bridge.noteLimitReset("nope", Date.now() + 60000);
    h = await request(port, "GET", "/v1/health");
    assert(typeof h.json.sites.chatgpt.limit_reset_at === "string" && !h.json.sites.nope, "noteLimitReset(site, ms) from the host (a notice seen outside a bridge request)");
    // the AI answers again -> the limit is over
    const p2 = request(port, "POST", "/v1/complete", { site: "claude", prompt: "again", request_id: "lim-2", timeout_ms: 10000 });
    await answer(bridge, sends, "claude", '{"ok": true}');
    const r2 = await p2;
    h = await request(port, "GET", "/v1/health");
    assert(r2.status === 200 && !("limit_reset_at" in h.json.sites.claude), "a real answer from that AI clears its reset time");
    // a rate-limit notice without a time -> no field
    const p3 = request(port, "POST", "/v1/complete", { site: "claude", prompt: "and again", request_id: "lim-3", timeout_ms: 10000 });
    await answer(bridge, sends, "claude", "You have reached your usage limit. Please try again later.", { siteError: "rate-limit" });
    const r3 = await p3;
    assert(r3.status === 503 && !("limit_reset_at" in r3.json), "no time in the notice -> no limit_reset_at (Akọwe checks every few minutes, as before)");
    await bridge.stop();
  }

  console.log("\n== followup: a short correction goes into the same chat, only when that chat is still current ==");
  {
    // an older host (no chatKey): never offers a follow-up, refuses followup_of without typing
    const { bridge, sends } = makeHost();
    await bridge.start();
    const port = bridge.status().port;
    const p = request(port, "POST", "/v1/complete", { site: "gemini", prompt: "the whole prompt", request_id: "old-1", timeout_ms: 10000 });
    await answer(bridge, sends, "gemini", "{broken");
    const r = await p;
    assert(r.status === 200 && !("followup" in r.json), "a host that can't tell which chat the pane shows: no followup in the 200");
    const n = sends.length;
    const f = await request(port, "POST", "/v1/complete", { site: "gemini", prompt: "fix your JSON", request_id: "old-2", followup_of: "old-1", timeout_ms: 10000 });
    assert(f.status === 409 && f.json.error === "FOLLOWUP_UNAVAILABLE" && /send the whole prompt/.test(f.json.message) && sends.length === n, `followup_of there -> 409 FOLLOWUP_UNAVAILABLE, nothing typed (${f.json && f.json.message})`);
    await bridge.stop();
  }
  {
    const key = { claude: "chat-A|3", chatgpt: "c-1|1", gemini: null };
    let userAt = 0;
    const { bridge, sends } = makeHost({ chatKey: (s) => key[s], userActedSince: (s, t) => userAt > t });
    await bridge.start();
    const port = bridge.status().port;
    let p = request(port, "POST", "/v1/complete", { site: "claude", prompt: "the whole 40,000-character prompt", request_id: "fu-1", timeout_ms: 10000 });
    await answer(bridge, sends, "claude", "{broken");
    let r = await p;
    assert(r.status === 200 && r.json.followup === true, "200 says followup: true (the chat can be continued)");
    assert(sends[sends.length - 1].meta.followup === undefined, "an ordinary request is not marked as a follow-up (the host may open a fresh chat first)");
    // (the bridge compares the host's chat key now with the key it had when the answer was taken)
    p = request(port, "POST", "/v1/complete", { site: "claude", prompt: "Your last answer was not valid JSON…", request_id: "fu-2", followup_of: "fu-1", timeout_ms: 10000 });
    await answer(bridge, sends, "claude", '{"ok": true}');
    r = await p;
    const last = sends[sends.length - 1];
    assert(r.status === 200 && last.text.startsWith("Your last answer was not valid JSON") && last.meta.followup === true, "followup_of the last answered request, same chat -> typed (only the short text), meta.followup = true");
    assert(r.json.followup === true, "a follow-up may be followed up again");
    // a chain: followup_of the follow-up works; followup_of the OLD one no longer does
    let n = sends.length;
    r = await request(port, "POST", "/v1/complete", { site: "claude", prompt: "fix it", request_id: "fu-3", followup_of: "fu-1", timeout_ms: 10000 });
    assert(r.status === 409 && r.json.error === "FOLLOWUP_UNAVAILABLE" && /was not the last one/.test(r.json.message) && sends.length === n, "followup_of an older request -> 409, nothing typed");
    // a fresh chat (or anything typed) in between -> the chat key changed
    key.claude = "chat-B|0";
    r = await request(port, "POST", "/v1/complete", { site: "claude", prompt: "fix it", request_id: "fu-4", followup_of: "fu-2", timeout_ms: 10000 });
    assert(r.status === 409 && /no longer shows the chat/.test(r.json.message) && sends.length === n, `a fresh chat in between -> 409 (${r.json.message})`);
    // the user used the pane since
    p = request(port, "POST", "/v1/complete", { site: "chatgpt", prompt: "whole prompt", request_id: "fu-5", timeout_ms: 10000 });
    await answer(bridge, sends, "chatgpt", "{bad");
    await p;
    userAt = Date.now() + 5;
    await sleep(10);
    n = sends.length;
    r = await request(port, "POST", "/v1/complete", { site: "chatgpt", prompt: "fix it", request_id: "fu-6", followup_of: "fu-5", timeout_ms: 10000 });
    assert(r.status === 409 && /used chatgpt's pane yourself/.test(r.json.message) && sends.length === n, "the user typed in that pane since -> 409, nothing typed");
    // another request to the same AI in between
    userAt = 0;
    p = request(port, "POST", "/v1/complete", { site: "chatgpt", prompt: "whole prompt", request_id: "fu-7", timeout_ms: 10000 });
    await answer(bridge, sends, "chatgpt", "{bad");
    await p;
    p = request(port, "POST", "/v1/complete", { site: "chatgpt", prompt: "another request", request_id: "fu-8", timeout_ms: 10000 });
    await answer(bridge, sends, "chatgpt", "{\"x\": 1}");
    await p;
    r = await request(port, "POST", "/v1/complete", { site: "chatgpt", prompt: "fix it", request_id: "fu-9", followup_of: "fu-7", timeout_ms: 10000 });
    assert(r.status === 409 && r.json.error === "FOLLOWUP_UNAVAILABLE", "another request to that AI in between -> 409");
    // a pane whose chat can't be told (key null) -> no followup offered
    p = request(port, "POST", "/v1/complete", { site: "gemini", prompt: "whole prompt", request_id: "fu-10", timeout_ms: 10000 });
    await answer(bridge, sends, "gemini", "{bad");
    r = await p;
    assert(r.status === 200 && !("followup" in r.json), "no chat key for that pane -> no followup offered");
    // malformed followup_of
    for (const bad of [42, "", "has spaces", "fu-11"]) {
      r = await request(port, "POST", "/v1/complete", { site: "claude", prompt: "x", request_id: "fu-11", followup_of: bad, timeout_ms: 10000 });
      assert(r.status === 400 && r.json.error === "BAD_REQUEST", `followup_of ${JSON.stringify(bad)} -> 400`);
    }
    // the host finds the chat changed while the follow-up waited its turn (a check-in went in first)
    {
      const s2 = []; let n2 = 500;
      const b2 = bridgeMod.createBridge({ port: 0, getToken: () => TOKEN, siteReady: () => true, chatKey: () => "k|1",
        sendToSite: (site, text, meta) => { s2.push({ site, text, meta }); if (meta.followup) return Promise.resolve({ ok: false, error: "FOLLOWUP_STALE" }); return Promise.resolve({ ok: true, seq: String(++n2) }); } });
      await b2.start();
      const port2 = b2.status().port;
      const p0 = request(port2, "POST", "/v1/complete", { site: "claude", prompt: "whole", request_id: "st-1", timeout_ms: 10000 });
      for (let i = 0; i < 100 && !b2.awaitingReply("claude"); i++) await sleep(5);
      b2.onCaptured({ site: "claude", text: "{bad", answers: [String(n2)] });
      await p0;
      const r0 = await request(port2, "POST", "/v1/complete", { site: "claude", prompt: "fix it", request_id: "st-2", followup_of: "st-1", timeout_ms: 10000 });
      assert(s2.length === 2 && s2[1].meta.followup === true && s2[1].meta.chatKey === "k|1", "the host gets meta.followup and the chat key it must still show");
      assert(r0.status === 409 && r0.json.error === "FOLLOWUP_UNAVAILABLE" && b2.status().active.claude === undefined, `the host says FOLLOWUP_STALE -> 409, the AI is free at once (${r0.json && r0.json.message})`);
      await b2.stop();
    }
    const ev = bridge.status().events.filter((e) => e.outcome === "FOLLOWUP_UNAVAILABLE");
    assert(ev.length >= 3 && ev.every((e) => e.http_status === 409), "each refused follow-up is in the activity feed (409)");
    const say = bridgeMod.describeEvent(ev[0], (s) => s).say;
    assert(/short correction/.test(say) && /whole request again/.test(say), `plain words for it: "${say}"`);
    await bridge.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
