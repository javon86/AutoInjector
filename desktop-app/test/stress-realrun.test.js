// test/stress-realrun.test.js — stress round 2, section R-D (desktop side): scenarios rebuilt from the real
// "What the Ice Kept" run of 2026-11-27 (build b4a0402). TESTS ONLY — nothing in the product is changed.
//
// What runs for real here (no copies): akowe-bridge.js (HTTP on 127.0.0.1, port 0), pane-health.js, self-repair.js
// (its page scripts run on test/fake-dom.js), relay-trace.js, fresh-chat.js (its page scripts too), run-guard.js
// (the notifier), and automation.js's REAL reply reader (buildReadScript) on fake chat pages. main.js's glue between
// them (sendTextTo, the poll loop, healthTick, selfRepairBusy, akoweFreshChatIfDue/startFreshChat, the retire rule
// for saved selectors) is SIMULATED in the "host" below, following main.js line by line where it matters (the line
// numbers are quoted). Part 2 (RD-2-*) also drives the REAL main.js under mock Electron in a child process.
// Akọwe's side is simulated from akowe/akowe/providers.py submit()/_complete(): timeout_ms = deadline - 5 s, and a
// 504 for a typed prompt is followed by ONE more request with the same request_id (it joins the late window).
//
// The clock: every module gets a virtual now(); every real timer is scaled by SCALE (the bridge's timeScale, the
// self-repair sleep, the host's poll loops), so 20 minutes of the run take ~1 s here. All waits are reported in
// REAL-RUN minutes. Results are printed as RESULT lines and written to $RD_RESULTS (JSON) when set.
//
// Run: NODE_PATH=$PWD/node_modules:/opt/node-tools/node_modules TMPDIR=/dev/shm node test/stress-realrun.test.js
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

if (process.argv[2] === "--main-child") { require("./stress-realrun-main-child.js"); return; } // eslint-disable-line

const bridgeMod = require("../akowe-bridge");
const { createPaneHealth } = require("../pane-health");
const SR = require("../self-repair");
const SITES = require("../selectors");
const { buildReadScript } = require("../automation");
const { createRelayTrace } = require("../relay-trace");
const freshChatMod = require("../fresh-chat");
const runGuard = require("../run-guard");
const { parseHTML, runScript, append } = require("./fake-dom");

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const RESULTS = [];
function result(id, scenario, grade, what, waitedMin, extra) {
  const r = Object.assign({ id, scenario, result: grade, what, waited_min: waitedMin == null ? null : Math.round(waitedMin * 10) / 10 }, extra || {});
  RESULTS.push(r);
  console.log(`RESULT ${id} ${grade} | ${scenario} | waited ${r.waited_min == null ? "-" : r.waited_min + " min"} | ${what}`);
}
const fmtT = (ms) => `${(ms / MIN).toFixed(1)}m`;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- virtual clock --------------------------------------------------------------------------------------------------
let SCALE = 1 / 500; // real ms per virtual ms: 1 virtual second = 2 real ms (a rig may pick another)
const MIN = 60000;
function makeClock() {
  const realStart = Date.now();
  const base = Date.UTC(2026, 10, 27, 8, 0, 0);
  const now = () => base + (Date.now() - realStart) / SCALE;
  return { now, base, sleep: (vms) => realSleep(Math.max(1, Math.round(vms * SCALE))), mins: (t) => (t - base) / MIN };
}

// ---- fake chat pages ---------------------------------------------------------------------------------------------------
// layout 'default': the site's usual markup (the built-in reply selectors match);
// 'changed': ChatGPT changed its page — nothing in selectors.js / self-repair's ALT_SELECTORS matches a reply;
// 'split': like 'changed', and a long reply is split into several blocks inside one turn (a check-in answer is one block).
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const SHELL = {
  chatgpt: (stop) => `<main><nav><a data-testid="create-new-chat-button" href="/">New chat</a></nav><div id="thread"></div><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div>${stop ? '<button data-testid="stop-button" aria-label="Stop streaming">Stop</button>' : '<button data-testid="send-button" aria-label="Send prompt">Send</button>'}</form></main>`,
  claude: (stop) => `<main><nav><a data-testid="new-chat-button" href="/new">New chat</a></nav><div id="thread"></div><fieldset><div contenteditable="true" class="ProseMirror"></div>${stop ? '<button aria-label="Stop response">Stop</button>' : '<button aria-label="Send message">Send</button>'}</fieldset></main>`,
  gemini: (stop) => `<main><nav><div data-test-id="new-chat-button"><button aria-label="New chat">New chat</button></div></nav><div id="thread"></div><form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>${stop ? '<button aria-label="Stop response">Stop</button>' : '<button aria-label="Send message">Send</button>'}</form></main>`
};
function blockHtml(site, layout, who, text) {
  const paras = String(text).split(/\n\n+/);
  if (layout === "changed" || layout === "split") {
    const role = who === "bot" ? "model" : "human";
    const inner = layout === "split" && who === "bot" && paras.length > 1 ? paras.map((p) => `<div class="body-x">${esc(p)}</div>`).join("") : `<div class="body-x">${esc(text)}</div>`;
    return `<div class="convo-turn ${who}-turn" data-turn-role="${role}">${inner}</div>`;
  }
  if (layout === "blocks") { // a turn per message, a reply split into one block per paragraph (RD-2; see the main.js child)
    return who === "bot" ? `<section class="turn">${paras.map((p) => `<div class="prose-block">${esc(p)}</div>`).join("")}</section>` : `<section class="turn"><div class="user-text">${esc(text)}</div></section>`;
  }
  if (site === "chatgpt") return who === "bot" ? `<div data-message-author-role="assistant"><div class="markdown">${esc(text)}</div></div>` : `<div data-message-author-role="user"><div class="whitespace-pre-wrap">${esc(text)}</div></div>`;
  if (site === "claude") return who === "bot" ? `<div class="font-claude-message">${esc(text)}</div>` : `<div data-testid="user-message">${esc(text)}</div>`;
  return who === "bot" ? `<model-response><message-content><div class="markdown">${esc(text)}</div></message-content></model-response>` : `<user-query><div class="query-text">${esc(text)}</div></user-query>`;
}
const URLS = { chatgpt: "https://chatgpt.com/c/abc", claude: "https://claude.ai/chat/abc", gemini: "https://gemini.google.com/app/abc" };

// ---- the rig: real modules + a simulated main.js host --------------------------------------------------------------
const TOKEN = "t".repeat(43);
async function makeRig(o) {
  o = o || {};
  SCALE = o.scale || 1 / 500;
  const clock = makeClock();
  const now = clock.now;
  const siteIds = ["chatgpt", "claude", "gemini"];
  const log = [];
  const ev = (kind, detail) => { log.push(Object.assign({ kind, at: now() }, detail || {})); };
  const sims = {};
  for (const s of siteIds) {
    const so = Object.assign({ layout: "default", answerMs: 60000, writeMs: 20000, replyChars: 4000, sendError: null, sendTryMs: 15000, newChatWorks: true, reloadFixes: false }, (o.sites || {})[s] || {});
    const sim = { site: s, o: so, history: [], generating: false, reloads: 0, homeReloads: 0, sends: 0, learned: {}, userAt: 0, waiting: false, waitingSince: 0, sending: false, lastCapturedRaw: null, lastRead: {}, chatChars: 0 };
    sim.build = () => {
      sim.doc = parseHTML(SHELL[s](sim.generating), { url: URLS[s] });
      const th = sim.doc.getElementById("thread");
      for (const h of sim.history) append(sim.doc, th, blockHtml(s, so.layout, h.who, h.text));
    };
    sim.add = (who, text) => { sim.history.push({ who, text }); sim.chatChars += String(text).length; sim.build(); };
    sim.build();
    sims[s] = sim;
  }
  const relayTrace = createRelayTrace({ now });
  const paneHealth = createPaneHealth({ sites: siteIds, now });
  const freshChat = freshChatMod.createFreshChat(Object.assign({ now }, o.freshChat || {}));
  let nextSeq = 1;
  let bridge = null;
  const effectiveOverrides = (s) => { const l = sims[s].learned.assistant; return l ? { assistant: l.selector, assistantStrict: true } : {}; };
  // main.js withEnvelope (the same text as akowe-bridge's defaultWrapPrompt)
  const withEnvelope = (text, s) => `${text}\n\n[Reply envelope required: start with [TO: USER] and end with [FROM: ${s.toUpperCase()}] — the closing tag is how this app knows your reply is complete; without it your reply is not received.]`;

  // The AI: answers what is typed (a check-in word, a reversed number, or an Akọwe prompt) after answerMs, writing for writeMs.
  function aiAnswer(s, text) {
    const sim = sims[s];
    const w = /Reply with only this word: ([a-z]+)/.exec(text);
    const body = w ? w[1] : (sim.o.replyBody ? sim.o.replyBody(text) : Array.from({ length: Math.max(1, Math.round(sim.o.replyChars / 400)) }, (_, i) => `Reply ${(sim.replyN = (sim.replyN || 0) + (i === 0 ? 1 : 0))}, paragraph ${i + 1}: ` + "lorem ipsum ".repeat(32).trim()).join("\n\n"));
    const t = w ? Math.min(sim.o.answerMs, 8000) : sim.o.answerMs;
    setTimeout(() => {
      sim.generating = true; sim.build();
      setTimeout(() => { sim.generating = false; sim.add("bot", `[TO: USER]\n${body}\n[FROM: ${s.toUpperCase()}]`); }, Math.max(1, Math.round((w ? 3000 : sim.o.writeMs) * SCALE)));
    }, Math.max(1, Math.round(t * SCALE)));
  }
  // main.js sendTextTo (2300-2375): stamp the [MSG #], type, prove; state.waiting = true after a good send.
  async function sendTextTo(s, text, opts) {
    const sim = sims[s];
    const seq = String(nextSeq++).padStart(4, "0");
    const token = opts && opts.cancelToken;
    if (token) token.seq = seq;
    relayTrace.noteSend({ seq, target: s, kind: opts && opts.probe ? "auto" : "program", text });
    relayTrace.noteTyping(seq);
    sim.sending = true;
    try {
      if (sim.o.sendError) {
        await clock.sleep(sim.o.sendTryMs * 3); // 3 tries, as in the log ("after 3 tries")
        relayTrace.noteSendResult(seq, { ok: false, error: sim.o.sendError });
        paneHealth.onSendResult(s, { ok: false, error: sim.o.sendError });
        ev("send-error", { site: s, seq, error: sim.o.sendError, attempts: 3, probe: !!(opts && opts.probe) });
        return { ok: false, error: sim.o.sendError };
      }
      if (token && token.cancelled) { relayTrace.noteSendResult(seq, { ok: false, error: "CANCELLED" }); return { ok: false, error: "CANCELLED" }; }
      sim.sends++;
      sim.add("human", `[MSG #${seq}]\n${text}`);
      relayTrace.noteSendResult(seq, { ok: true, verified: true });
      paneHealth.onSendResult(s, { ok: true, verified: true });
      sim.waiting = true; sim.waitingSince = now(); sim.lastActivityAt = now();
      ev("sent", { site: s, seq, probe: !!(opts && opts.probe), chars: text.length });
      aiAnswer(s, text);
      return { ok: true, verified: true, seq };
    } finally { sim.sending = false; }
  }
  // main.js selfRepairBusy (9552-9582), the parts these scenarios reach
  const CHECKIN_OWED_DEMAND_MS = 3 * MIN, CHECKIN_OWED_MS = 10 * MIN, CHECKIN_USER_IDLE_MS = 2 * MIN;
  function selfRepairBusy(s, level) {
    const sim = sims[s];
    if (sim.generating) return "busy";
    if (sim.sending) return "sending";
    try { const st = bridge && bridge.status(); if (st && st.active && st.active[s]) return "akowe"; } catch (_) {}
    if (bridge && bridge.awaitingReply(s)) return "akowe";
    const owed = relayTrace.openMessages(s).filter((m) => m.kind !== "auto");
    if (owed.some((m) => now() - m.at < (level === "demand" ? CHECKIN_OWED_DEMAND_MS : CHECKIN_OWED_MS))) return "waiting";
    if (now() - (sim.userAt || 0) < CHECKIN_USER_IDLE_MS) return "typing";
    const waitingFor = sim.waiting && sim.waitingSince ? now() - sim.waitingSince : 0;
    if (waitingFor && waitingFor < (level === "demand" ? CHECKIN_OWED_DEMAND_MS : CHECKIN_OWED_MS)) return "waiting";
    if (level !== "demand" && now() - (sim.lastActivityAt || 0) < (level === "periodic" ? 5 * MIN : 20000)) return "recent";
    return null;
  }
  const selfRepair = SR.createSelfRepair({
    sites: siteIds, SITES, now, sleep: clock.sleep, label: (s) => SITES[s].label,
    overrides: effectiveOverrides,
    runPage: (s, script) => runScript(script, sims[s].doc),
    reload: async (s, opt) => {
      const sim = sims[s]; sim.reloads++;
      const home = !!(opt && opt.home);
      if (home) { sim.homeReloads++; sim.history = []; sim.chatChars = 0; }
      if (sim.o.reloadFixes) { sim.o.layout = "default"; sim.o.sendError = null; }
      sim.build();
      ev("reload", { site: s, by: (opt && opt.why) || "self-repair", home });
      return { ok: true };
    },
    readState: (s) => { const lr = sims[s].lastRead; return { text: lr.text || "", textLen: lr.textLen || 0, generating: !!sims[s].generating, generatingMs: 0, loadFailed: false, inputFound: lr.inputFound }; },
    sendProbe: (s, text, token) => sendTextTo(s, withEnvelope(text, s), { probe: true, cancelToken: token }).then((r) => ({ ok: !!r.ok, error: r.error, verified: r.verified })),
    saveLearned: (s, role, sel, how) => { sims[s].learned[role] = { selector: sel, how, learnedAt: now() }; ev("selector-learned", { site: s, role, selector: sel, how }); },
    savePick: (s, role, sel, how) => { sims[s].learned[role] = { selector: sel, how, learnedAt: now() }; return true; },
    teachOverrides: () => {},
    busyReason: selfRepairBusy, isActive: () => true,
    log: (k, d) => ev(k, d),
    onChange: (s, snap, e) => { if (e && e.kind) ev("repair-change", { site: s, state: snap.state, change: e.kind, code: e.code, ask: e.ask }); },
    options: Object.assign({ intervalMs: 20 * MIN, pollStepMs: 1000, reloadSettleMs: 4000, unfreezeWaitMs: 3000 }, o.selfRepair || {})
  });
  // main.js akoweFreshChatIfDue / startFreshChatNow (9844-9890)
  const freshChatBusy = (s) => !!(sims[s].generating || sims[s].waiting || sims[s].sending);
  const heldSaid = {};
  async function akoweFreshChatIfDue(s, ct, book) {
    if (book) freshChat.noteBook(s, book);
    const d = freshChat.due(s, { busy: freshChatBusy(s), userAt: sims[s].userAt });
    if (!d.due) {
      if (d.held && heldSaid[s] !== d.held) { heldSaid[s] = d.held; ev("akowe-fresh-chat-held", { site: s, reason: d.reason, held: d.held, requests: d.requests, chars: d.chars }); }
      return { started: false, held: d.held || null };
    }
    delete heldSaid[s];
    const sim = sims[s];
    const ov = effectiveOverrides(s);
    const click = await runScript(freshChatMod.buildNewChatScript(s), sim.doc);
    let how = "address", ok = true;
    if (click && click.ok && click.clicked) {
      if (sim.o.newChatWorks) { sim.history = []; sim.chatChars = 0; sim.build(); }
      await clock.sleep(2500);
      const chk = await runScript(freshChatMod.buildFreshCheckScript([ov.assistant].concat(SITES[s].ASSISTANT_CANDIDATES).filter(Boolean), SITES[s].INPUT_CANDIDATES), sim.doc);
      if (chk && chk.ok && chk.replies === 0 && chk.input) { how = "button"; sim.lastCapturedRaw = null; }
    }
    if (how === "address") { sim.reloads++; sim.homeReloads++; sim.history = []; sim.chatChars = 0; sim.build(); ev("reload", { site: s, by: "fresh-chat", home: true }); }
    freshChat.reset(s);
    ev("akowe-fresh-chat", { site: s, reason: d.reason, requests: d.requests, chars: d.chars, how, ok, chatCharsLeft: sim.chatChars });
    return { started: true, how };
  }
  // the bridge, wired like main.js startAkoweBridgeNow (9900-9965)
  bridge = bridgeMod.createBridge({
    port: 0, getToken: () => TOKEN, now, timeScale: SCALE,
    siteReady: () => true, siteState: (s) => selfRepair.health(s),
    chatKey: (s) => `${s}:${freshChat.snapshot()[s] ? freshChat.snapshot()[s].fresh : 0}:${sims[s].history.length}`,
    userActedSince: (s, t) => (sims[s].userAt || 0) >= t,
    startProbe: (list) => selfRepair.probeMany(list, "akowe", "demand"),
    sendToSite: async (s, text, meta) => {
      const ct = meta && meta.cancelToken;
      // selfRepairMakeWay: a check-in under way is let finish first (bounded)
      // (main.js selfRepairMakeWay 9585: at most CHECKIN_YIELD_MAX_MS = 60 s)
      if (selfRepair.makeWay(s) !== "none") { ev("checkin-yield", { site: s }); for (let i = 0; i < 600 && selfRepair.busyWithSite(s) && !(ct && ct.cancelled); i++) await clock.sleep(100); }
      if (ct && ct.cancelled) return { ok: false, error: "CANCELLED", seq: null };
      if (!(meta && meta.followup)) await akoweFreshChatIfDue(s, ct, meta && meta.book);
      if (ct && ct.cancelled) return { ok: false, error: "CANCELLED", seq: null };
      const r = await sendTextTo(s, text, { bridge: true, cancelToken: ct });
      if (r.ok) freshChat.noteSent(s, text.length);
      return { ok: !!r.ok, error: r.error, seq: r.ok ? r.seq : null, verified: r.ok ? true : null };
    },
    logger: (kind, d) => ev(`akowe-${kind}`, d),
    onEvent: (e) => { if (e && e.kind === "outcome" && e.site && ["TIMEOUT", "LATE_EXPIRED", "SEND_FAILED"].includes(e.outcome)) selfRepair.requestCheck(e.site, `akowe-${String(e.outcome).toLowerCase()}`); }
  });
  await bridge.start();
  const port = bridge.status().port;
  // main.js pollSite (4530-4990), the parts these scenarios reach: the REAL read script, pane health, capture, ownership.
  const hasEndTag = (t) => /\[\s*FROM:\s*[^\]\r\n]{1,40}\]\s*$/i.test(String(t || "").trim());
  let turnId = 1;
  const hooks = { onRead: null, onCapture: null };
  async function pollSite(s) {
    const sim = sims[s];
    const res = await runScript(buildReadScript(s, effectiveOverrides(s)), sim.doc);
    const text = (res && res.text) || "";
    sim.lastRead = { text, textLen: text.length, inputFound: res && res.inputFound, res };
    paneHealth.onRead(s, { textLen: text.length, generating: !!(res && res.generating), hasEndTag: hasEndTag(text), tail: text.slice(-160), inputFound: res && res.inputFound });
    if (res && res.generating) relayTrace.noteGenerating(s);
    if (hooks.onRead) hooks.onRead(s, res);
    if (!res || res.generating || !hasEndTag(text) || text === sim.lastCapturedRaw) return;
    sim.lastCapturedRaw = text;
    const id = turnId++;
    relayTrace.noteCapture(s, id);
    const answers = relayTrace.answersOf(id);
    paneHealth.onCapture(s);
    sim.waiting = false; sim.lastActivityAt = now();
    freshChat.noteReply(s, text.length);
    if (hooks.onCapture) hooks.onCapture(s, res, text);
    if (selfRepair.expects(s, text, answers)) { selfRepair.onCaptured(s, { text, answers }); ev("captured", { site: s, owner: "check-in", answers }); return; }
    const owned = bridge.onCaptured({ site: s, text, answers });
    if (owned) selfRepair.noteWorking(s);
    ev("captured", { site: s, owner: owned ? "akowe" : "relay", answers, chars: text.length, fragment: !!(res && res.fragmentFixed) });
  }
  const timers = [];
  let polling = false;
  timers.push(setInterval(async () => { if (polling) return; polling = true; try { for (const s of siteIds) await pollSite(s); } catch (e) { ev("poll-error", { error: String(e && e.stack || e) }); } polling = false; }, Math.max(1, Math.round(3000 * SCALE))));
  // main.js healthTick (1254-1262): every 5 s
  timers.push(setInterval(() => {
    for (const st of paneHealth.newStalls()) {
      ev("capture-stalled", { site: st.site, minutes: st.minutes, reason: st.reason, textLen: st.read ? st.read.textLen : null });
      selfRepair.requestCheck(st.site, "stalled");
      if (o.onStall) { try { o.onStall(st.site, { bridge, selfRepair }); } catch (_) {} } // a SIMULATED hook (main.js has none)
    }
  }, Math.max(1, Math.round(5000 * SCALE))));
  timers.push(setInterval(() => { selfRepair.tick().catch(() => {}); }, Math.max(1, Math.round(15000 * SCALE))));

  function request(method, p, body, timeoutMs) {
    return new Promise((resolve) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const headers = { Authorization: `Bearer ${TOKEN}` };
      if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
        const ch = []; res.on("data", (c) => ch.push(c));
        res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString("utf8")); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      req.on("error", (e) => resolve({ status: 0, json: { error: String(e) } }));
      if (data) req.write(data);
      req.end();
      void timeoutMs;
    });
  }
  // Akọwe's submit()/_complete() (providers.py 994-1125): one attempt; a typed 504 -> one more POST with the same id.
  async function akoweAttempt(site, requestId, deadlineMs, extra) {
    const t0 = now();
    const tmo = Math.max(10000, Math.min(900000, deadlineMs - 5000));
    const body = Object.assign({ site, prompt: `Write the next part of the book. (${requestId})`, request_id: requestId, timeout_ms: tmo }, extra || {});
    const steps = [];
    let r = await request("POST", "/v1/complete", body);
    steps.push({ status: r.status, error: r.json && r.json.error, at_min: (now() - t0) / MIN });
    if (r.status === 504 && r.json && r.json.typed === true && !r.json.late_expired) {
      const again = Object.assign({}, body, { timeout_ms: Math.max(10000, Math.min(900000, Number(r.json.late_window_ms) || tmo)) });
      r = await request("POST", "/v1/complete", again);
      steps.push({ status: r.status, error: r.json && r.json.error, late_expired: !!(r.json && r.json.late_expired), at_min: (now() - t0) / MIN });
    }
    return { status: r.status, json: r.json, steps, minutes: (now() - t0) / MIN, ok: r.status === 200 };
  }
  const health = async () => (await request("GET", "/v1/health")).json;
  async function stop() {
    if (process.env.RD_DEBUG) for (const e of log) if (e.site === process.env.RD_DEBUG || !e.site) console.log("   DBG", fmtT(e.at - clock.base), e.kind, JSON.stringify(Object.assign({}, e, { kind: undefined, at: undefined })).slice(0, 200));
    for (const t of timers) clearInterval(t); try { await bridge.stop(); } catch (_) {} await realSleep(20); }
  const since = (t) => (now() - t) / MIN;
  const kinds = (k, site) => log.filter((e) => e.kind === k && (!site || e.site === site));
  // wait (in virtual ms) until fn() is truthy
  async function waitV(fn, vms) { const end = Date.now() + vms * SCALE + 50; while (Date.now() < end) { const r = await fn(); if (r) return r; await realSleep(2); } return null; }
  const idle = (vms) => clock.sleep(vms);
  return { waitV, idle, clock, now, sims, bridge, selfRepair, paneHealth, relayTrace, freshChat, log, ev, kinds, since, akoweAttempt, health, request, stop, hooks, sendTextTo, effectiveOverrides, withEnvelope };
}


const fmt = (m) => (m == null ? "?" : m.toFixed(1));
const firstAt = (rig, kind, site, after) => { const e = rig.log.find((x) => x.kind === kind && (!site || x.site === site) && (!after || x.at > after)); return e ? e.at : null; };
const BOOK = { book_id: "proj-ice", run_id: "run-ice" };

// =====================================================================================================================
// RD-1: the AI has answered on the page, but the reply selector matches nothing (capture-stalled)
// =====================================================================================================================
async function rd1() {
  console.log("\n== RD-1 ChatGPT answered, the reply selector matches nothing (capture-stalled) ==");
  let rig = await makeRig({ sites: { chatgpt: { layout: "changed", answerMs: 90000, writeMs: 30000 } } });
  try {
    const t0 = rig.now();
    const a0 = await rig.akoweAttempt("chatgpt", "run-ice:bible:c0-chatgpt", 899000, BOOK);
    const stall = rig.kinds("capture-stalled", "chatgpt")[0];
    const stallMin = stall ? (stall.at - t0) / MIN : null;
    const endAt = (rig.kinds("akowe-outcome", "chatgpt").find((e) => e.outcome === "LATE_EXPIRED") || {}).at || rig.now();
    const checksDuring = rig.selfRepair.events().filter((e) => e.site === "chatgpt" && e.kind === "probe" && e.at < endAt).length;
    const pend = rig.selfRepair.events().filter((e) => e.site === "chatgpt" && e.kind === "pending").map((e) => e.reason);
    const outs = rig.kinds("akowe-outcome", "chatgpt").map((e) => `${e.outcome} at ${Math.round((e.elapsed_ms || 0) / 1000)} s`);
    const h0 = await rig.health();
    assert(stall && /reply selector matches nothing/.test(stall.reason) && stall.textLen === 0, `capture-stalled ${fmt(stallMin)} min after the prompt: "${stall && stall.reason}"`);
    assert(a0.status === 504 && a0.json && a0.json.late_expired === true, `Akọwe's first try ends 504 late_expired after ${fmt(a0.minutes)} min (${outs.join(", ")})`);
    assert(checksDuring === 0 && pend.includes("stalled"), `the stall only QUEUES a check-in (pending: ${pend.join(", ")}); none runs while the request is open (${checksDuring})`);
    assert(h0.sites.chatgpt.ready === true && !["broken", "needs_user", "repairing"].includes(h0.sites.chatgpt.state), `/v1/health right after: ChatGPT ready=${h0.sites.chatgpt.ready}, state ${h0.sites.chatgpt.state}, problem ${h0.sites.chatgpt.problem}`);
    result("RD-1-a", "ChatGPT's reply is on the page, the reply selector matches nothing — Akọwe's first try (deadline 900 s)", "⚠️",
      `capture-stalled at ${fmt(stallMin)} min (textLen 0, generating false), yet the request ran to its deadline and the late window: ${outs.join(", ")} → 504 late_expired after ${fmt(a0.minutes)} min. Nothing ends or hands back the request at the stall; the stall only queues a check-in, which cannot run while the request (and its late window) is open (self-repair busy reason "akowe"). /v1/health keeps ChatGPT ready=true (state ${h0.sites.chatgpt.state}) — nothing tells Akọwe to use another AI.`,
      a0.minutes - stallMin, { stall_min: stallMin, request_min: a0.minutes });

    // Akọwe retries at once (-c1-, deadline 300 s), to ChatGPT again (as in the log)
    const hb = await rig.health();
    const t1 = rig.now();
    const a1 = await rig.akoweAttempt("chatgpt", "run-ice:bible:c1-chatgpt", 300000, BOOK);
    const learnedBetween = rig.kinds("selector-learned", "chatgpt").filter((e) => e.at < t1 + a1.minutes * MIN).length;
    const yields = rig.selfRepair.events().filter((e) => e.site === "chatgpt" && (e.kind === "yield" || (e.kind === "result" && /DISPLACED/.test(String(e.outcome))))).length;
    assert(hb.sites.chatgpt.ready === true && a1.status === 504, `the retry goes to a "ready" ChatGPT and times out again: ${a1.steps.map((x) => `${x.status}@${fmt(x.at_min)}`).join(" → ")}`);
    assert(learnedBetween === 0, `the queued check-in never repaired anything between the tries (learned: ${learnedBetween}; a check-in made way for Akọwe ${yields}×)`);
    // nothing asks for ChatGPT any more: the check-in finally runs
    const tFree = rig.now();
    await rig.waitV(() => rig.kinds("selector-learned", "chatgpt").length > 0 || rig.selfRepair.state("chatgpt").state === "broken", 15 * MIN);
    const learnAt = firstAt(rig, "selector-learned", "chatgpt");
    const total = (rig.now() - t0) / MIN;
    result("RD-1-b", "…Akọwe retries at once (-c1-, deadline 300 s) — to ChatGPT again", "⚠️",
      `the retry also timed out: ${a1.steps.map((x) => `${x.status} at ${fmt(x.at_min)} min`).join(", then ")} (log: TIMEOUT ~295 s, LATE_EXPIRED ~590 s). The check-in queued at ${fmt(stallMin)} min never repaired anything between the tries (Akọwe's retry took the site first${yields ? `; a check-in that had just started made way for it ${yields}×` : ""}). Only when nothing asked for ChatGPT did it run: the page search re-learned the reader ${learnAt ? `at ${fmt((learnAt - t0) / MIN)} min (${fmt((learnAt - tFree) / MIN)} min after the last try)` : "— never"}. Both answers were on the page; ${fmt(a0.minutes + a1.minutes)} min lost for one request.`,
      a0.minutes + a1.minutes, { retry_min: a1.minutes, learn_min: learnAt ? (learnAt - t0) / MIN : null, total_min: total });
  } finally { await rig.stop(); }

  // RD-1-c: the same with a hand-back at the stall (SIMULATED hook: bridge.release() exists, nothing calls it on a stall)
  console.log("\n== RD-1-c the same, with a SIMULATED hand-back at the stall (bridge.release on capture-stalled) ==");
  rig = await makeRig({ sites: { chatgpt: { layout: "changed", answerMs: 90000, writeMs: 30000 } }, onStall: (site, x) => { if (x.bridge.awaitingReply(site)) x.bridge.release(site, "stalled"); } });
  try {
    const t0 = rig.now();
    const a0 = await rig.akoweAttempt("chatgpt", "run-ice:bible:c0-chatgpt", 899000, BOOK);
    await rig.waitV(() => rig.kinds("selector-learned", "chatgpt").length > 0 && !rig.selfRepair.state("chatgpt").running, 10 * MIN);
    const learnAt = firstAt(rig, "selector-learned", "chatgpt");
    const a1 = await rig.akoweAttempt("chatgpt", "run-ice:bible:c1-chatgpt", 300000, BOOK);
    const total = (rig.now() - t0) / MIN;
    assert(a0.status === 504 && a0.minutes < 6, `with the hand-back Akọwe hears 504 after ${fmt(a0.minutes)} min, not 20`);
    assert(a1.ok, `the check-in re-learns the reader ${learnAt ? `at ${fmt((learnAt - t0) / MIN)} min` : "never"}; the retry is answered (${a1.status}) after ${fmt(a1.minutes)} min`);
    result("RD-1-c", "…what a hand-back at the stall would give (SIMULATED hook, not in the product)", "✅",
      `Akọwe got 504 at ${fmt(a0.minutes)} min, the check-in ran at once and the page search re-learned the reader at ${learnAt ? fmt((learnAt - t0) / MIN) : "?"} min; the retry was answered after ${fmt(a1.minutes)} min — ${fmt(total)} min in all instead of ~30. (Shows the size of the saving; Akọwe could also move to another AI at the 504.)`,
      total, { simulated: true });
  } finally { await rig.stop(); }

  // RD-1-d: the page search cannot learn the reader either (every reply flat in one container)
  console.log("\n== RD-1-d the reply is unreadable AND the page search cannot learn it ==");
  rig = await makeRig({ sites: { chatgpt: { layout: "changed", answerMs: 90000, writeMs: 30000 } } });
  try {
    const sim = rig.sims.chatgpt;
    sim.build = () => { sim.doc = parseHTML(SHELL.chatgpt(sim.generating), { url: URLS.chatgpt }); const th = sim.doc.getElementById("thread"); for (const h of sim.history) append(sim.doc, th, `<p class="flat">${esc(h.text)}</p>`); };
    sim.build();
    const t0 = rig.now();
    const tries = [];
    for (const [id, dl] of [["c0", 899000], ["c1", 300000]]) {
      const h = await rig.health();
      const a = await rig.akoweAttempt("chatgpt", `run-ice:review:${id}-chatgpt`, dl, BOOK);
      tries.push({ id, status: a.status, err: a.json && a.json.error, min: a.minutes, ready: h.sites.chatgpt.ready, state: h.sites.chatgpt.state });
    }
    await rig.waitV(() => { const st = rig.selfRepair.state("chatgpt"); return !st.running && (st.state === "broken" || st.state === "ok") && rig.selfRepair.events().some((e) => e.kind === "result" && e.site === "chatgpt"); }, 20 * MIN);
    const brokenAt = firstAt(rig, "repair-change", "chatgpt");
    const st = rig.selfRepair.state("chatgpt");
    const h = await rig.health();
    const a2 = await rig.akoweAttempt("chatgpt", "run-ice:review:c2-chatgpt", 300000, BOOK);
    assert(tries.every((t) => t.status === 504 && t.ready === true), `two tries, both 504 while health said ready (${tries.map((t) => `${t.id} ${fmt(t.min)} min`).join(", ")})`);
    assert(st.state === "broken" && h.sites.chatgpt.ready === false && a2.status === 503, `only afterwards: self-repair "broken" (${st.problem}), health ready=false, the next request 503 at once (${a2.json && a2.json.error})`);
    result("RD-1-d", "…and the page search cannot learn the reader either", "⚠️",
      `${tries.map((t) => `${t.id}: 504 after ${fmt(t.min)} min (health: ready=${t.ready}, ${t.state})`).join("; ")}. Then the check-in ran: alternatives → page search → reload all failed → "broken" (${st.problem}) at ${brokenAt ? fmt((rig.now() - t0) / MIN) : "?"} min, ONE notice for the user. From then on /v1/health says ready=false and a request gets 503 SITE_NOT_READY at once (good) — but ~${fmt((tries[0].min + tries[1].min))} min went first.`,
      tries[0].min + tries[1].min, { tries });
  } finally { await rig.stop(); }
}

// =====================================================================================================================
// RD-2: a learned reply selector that reads only a fragment -> stale x3 -> retired -> matches nothing (flip-flop)
// =====================================================================================================================
function runChild() {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    const c = fork(__filename, ["--main-child"], { env, silent: true });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", () => {});
    c.on("exit", () => { const m = /CHILD_RESULT (.*)/.exec(out); let j = null; try { j = m ? JSON.parse(m[1]) : null; } catch (_) {} resolve(j || { error: "no result", out: out.slice(-500) }); });
  });
}
async function rd2() {
  console.log("\n== RD-2-a the REAL main.js: learned reader reads a fragment ×3 -> retired -> reads nothing -> re-learned -> … ==");
  const r = await runChild();
  if (r.error) { assert(false, `main.js child: ${r.error}`); result("RD-2-a", "learned reader flip-flop in the real main.js", "❌", `child failed: ${r.error}`, null); }
  else {
    const c1 = r.cycles[0] || {}, c2 = r.cycles[1] || {};
    assert(c1.retiredLog && c1.retiredLog.length === 1 && c1.retiredLog[0].after === 3, `the learned "div.prose-block" (it reads each reply via its 'climb' fix) is retired after ${c1.retiredAfter} fragment reads ("${c1.retiredLog && c1.retiredLog[0] && c1.retiredLog[0].selector}")`);
    assert(c1.stallReason && /matches nothing/.test(c1.stallReason), `the next reply is not read: capture-stalled "${c1.stallReason}"`);
    assert(c1.relearned === "div.prose-block" && c2.relearned === "div.prose-block" && c2.retiredLog && c2.retiredLog.length === 1, `the check-in's page search learns THE SAME selector again, and an hour later it is retired again (cycle 2: retired after ${c2.retiredAfter} reads)`);
    result("RD-2-a", "the REAL main.js: a learned reader that reads replies only through its fragment fix", "⚠️",
      `selector-learned "div.prose-block" (page-search, from a one-block check-in answer) reads every split reply only through the reader's 'climb' fix → counted as a failure ("reply-selector-fragment") → retired after 3 replies ("the built-in one works" — it does not: it matches nothing) → the next reply is unreadable (capture-stalled "matches nothing") → the stall's check-in re-learns the SAME selector by page search → an hour later it is retired again (cycle 2 after ${c2.retiredAfter} reads). The lost user reply was re-sent by the carry-on follow-up (${c1.carryOn ? c1.carryOn.resent : "-"}); an Akọwe request gets no such help (see RD-2-b).`,
      null, { child: r });
  }

  for (const [id, gapMs, label] of [["RD-2-b", 6 * MIN, "Akọwe asks ChatGPT every ~6 min (it uses Gemini / Claude in between)"], ["RD-2-c", 2 * MIN, "Akọwe asks ChatGPT every ~2 min"], ["RD-2-d", 30000, "Akọwe asks ChatGPT back to back (30 s apart)"]]) {
    console.log(`\n== ${id} the flip-flop during Akọwe requests: ${label} (rig; the retire rule SIMULATED from main.js noteSavedSelectorOutcome) ==`);
    const rig = await makeRig({ scale: 1 / 1000, sites: { chatgpt: { layout: "blocks", answerMs: 120000, writeMs: 40000, replyChars: 3000 } } });
    try {
      const H = 60 * MIN;
      rig.sims.chatgpt.learned.assistant = { selector: "div.prose-block", how: "page-search", learnedAt: rig.now() - 2 * H };
      const streak = { n: 0 };
      rig.hooks.onCapture = (s, res) => {
        const l = rig.sims[s].learned.assistant;
        if (!l) return;
        if (res && res.fragmentFixed) {
          streak.n++;
          if (streak.n >= 3 && rig.now() - l.learnedAt >= H) { delete rig.sims[s].learned.assistant; streak.n = 0; rig.ev("selector-retired", { site: s, selector: l.selector, after: 3 }); }
        } else streak.n = 0;
      };
      const t0 = rig.now();
      const reqs = [];
      for (let i = 0; i < 16 && rig.now() - t0 < 6 * H; i++) {
        for (const [c, dl] of [["c0", 899000], ["c1", 300000]]) {
          const a = await rig.akoweAttempt("chatgpt", `run-ice:review${i}:${c}-chatgpt`, dl, BOOK);
          reqs.push({ i, c, ok: a.ok, min: a.minutes, at: (rig.now() - t0) / MIN });
          if (a.ok) break;
        }
        await rig.idle(gapMs);
      }
      const seq = rig.log.filter((e) => e.site === "chatgpt" && ["selector-learned", "selector-retired"].includes(e.kind)).map((e) => `${e.kind.replace("selector-", "")} ${fmt((e.at - t0) / MIN)}`);
      const retired = rig.kinds("selector-retired", "chatgpt").length, learned = rig.kinds("selector-learned", "chatgpt").length;
      const timeouts = reqs.filter((x) => !x.ok);
      const lostMin = timeouts.reduce((acc, x) => acc + x.min, 0);
      const nReq = new Set(reqs.map((x) => x.i)).size;
      const failedReqs = new Set(reqs.filter((x) => x.c === "c1" && !x.ok).map((x) => x.i)).size;
      const total = (rig.now() - t0) / MIN;
      const yields = rig.log.filter((e) => e.site === "chatgpt" && e.kind === "yield").length;
      if (id !== "RD-2-d") assert(retired >= 1 && learned >= 1, `flip-flop: retired ×${retired}, re-learned ×${learned} in ${fmt(total / 60)} h (${seq.join(", ")})`);
      else assert(retired >= 1 && learned === 0 && failedReqs >= 3, `back to back: retired ×${retired}, never re-learned (a check-in made way for Akọwe ${yields}×), ${failedReqs} of ${nReq} requests failed`);
      result(id, `…the same flip-flop while ${label}`, "⚠️",
        id !== "RD-2-d"
          ? `in ${fmt(total / 60)} h, ${nReq} requests: ${seq.join(" → ")} (minutes). ${timeouts.length} tries timed out (${failedReqs} requests failed both tries), ${fmt(lostMin)} min lost. Each retire costs the next ChatGPT request ~20 min (first try) + ~10 min (the retry) before the stall's check-in may run; the page search then learns the SAME fragment selector, which is retired again an hour (3 replies) later.`
          : `${seq[0] || "retired ?"} min and never re-learned: the check-in queued by every stall started in the short gaps but made way for Akọwe's next request ${yields}× (selfRepairMakeWay). ${failedReqs} of ${nReq} requests failed both tries, ${fmt(lostMin)} min lost in ${fmt(total / 60)} h — the reader stays dead as long as Akọwe keeps ChatGPT busy.`,
        lostMin, { retired, learned, timeouts: timeouts.length, failed_requests: failedReqs, requests: nReq, sequence: seq });
    } finally { await rig.stop(); }
  }
}

// =====================================================================================================================
// RD-3: a send that is never confirmed (SEND_NOT_CONFIRMED x3) and a reload that does not fix it
// =====================================================================================================================
async function rd3() {
  console.log("\n== RD-3 Claude: SEND_NOT_CONFIRMED ×3 after 3 tries, the self-repair reload does not fix it ==");
  const rig = await makeRig({ scale: 1 / 2000, sites: { claude: { sendError: "SEND_NOT_CONFIRMED", sendTryMs: 15000 } } });
  try {
    const shows = [];
    const notifier = runGuard.createNotifier({ now: rig.now, show: (c) => shows.push({ at: rig.now(), key: c.key, again: c.again, title: c.title }) });
    const panes = () => Object.fromEntries(["chatgpt", "claude", "gemini"].map((s) => [s, { label: SITES[s].label, active: true, health: rig.selfRepair.health(s) }]));
    const tick = setInterval(() => notifier.update(runGuard.conditionsFrom({ run: { id: "run-ice", state: "writing", title: "x" }, sites: panes(), watching: true })), Math.max(1, Math.round(15000 * SCALE)));
    const t0 = rig.now();
    const a0 = rig.akoweAttempt("claude", "run-ice:writers_room:c0-claude", 899000, BOOK);
    await rig.idle(5000);
    const busy = await rig.akoweAttempt("claude", "run-ice:review:c0-claude", 899000, BOOK); // a 2nd Akọwe call meanwhile
    const r0 = await a0;
    const tFail = rig.now();
    // Akọwe asks Claude again a moment later (registry retry) -> what does it get while the repair runs / after?
    await rig.idle(20000);
    const r1 = await rig.akoweAttempt("claude", "run-ice:writers_room:c1-claude", 300000, BOOK);
    await rig.waitV(() => rig.selfRepair.state("claude").state === "broken" && !rig.selfRepair.state("claude").running, 30 * MIN);
    const brokenAt = rig.now();
    const st = rig.selfRepair.state("claude");
    const r2 = await rig.akoweAttempt("claude", "run-ice:writers_room:c2-claude", 300000, BOOK);
    const g = await rig.akoweAttempt("gemini", "run-ice:writers_room:c0-gemini", 899000, BOOK);
    // 6 hours of the run go by (Claude stays broken)
    await rig.idle(6 * 60 * MIN - (rig.now() - t0));
    clearInterval(tick);
    const sendErrs = rig.kinds("send-error", "claude");
    const reloads = rig.kinds("reload", "claude").length;
    const rechecks = rig.log.filter((e) => e.site === "claude" && e.kind === "probe" && e.reason === "broken-recheck").map((e) => fmt((e.at - t0) / MIN));
    const paneShows = shows.filter((x) => x.key.startsWith("pane:claude"));
    const asks = rig.kinds("ask_user", "claude").length; // (self-repair log lines; its own event ring keeps only 60)
    assert(r0.status === 502 && r0.json.error === "SEND_FAILED", `Akọwe's request: 502 SEND_FAILED after ${fmt(r0.minutes)} min (3 tries)`);
    assert(busy.status === 409, `a second Akọwe call while the first is being typed: 409 SITE_BUSY (${busy.json && busy.json.error}) — never queued, never handed elsewhere`);
    assert(st.state === "broken" && st.problem === "SEND_NOT_CONFIRMED" && reloads >= 1, `self-repair: alternatives, ${reloads} reload(s), then "broken" SEND_NOT_CONFIRMED ${fmt((brokenAt - tFail) / MIN)} min after the failure`);
    assert(r2.status === 503 && r2.json.state === "broken" && g.ok, `after that Akọwe gets 503 SITE_NOT_READY (broken) at once (${fmt(r2.minutes)} min) and Gemini answers (${g.status})`);
    assert(asks === 1, `the user is asked once by self-repair (ask_user ×${asks})`);
    result("RD-3-a", "Claude's send is never confirmed (SEND_NOT_CONFIRMED ×3), the reload does not fix it — Akọwe's requests", "🟡",
      `1st request: 502 SEND_FAILED after ${fmt(r0.minutes)} min; a 2nd call meanwhile: 409 SITE_BUSY; a retry 20 s later: ${r1.status} ${r1.json && r1.json.error}${r1.json && r1.json.state ? ` (${r1.json.state})` : ""} after ${fmt(r1.minutes)} min; Claude "broken" (SEND_NOT_CONFIRMED) ${fmt((brokenAt - tFail) / MIN)} min after the failure (alternatives, ${reloads} reload, no automatic teach). From then on: 503 at once (state broken), and Gemini answered. The bridge never hands a request to another AI by itself — that is Akọwe's job (its 503/502 carry ambiguous:false).`,
      r0.minutes + r1.minutes, { send_errors: sendErrs.length });
    const between = paneShows.map((x, i) => (i ? (x.at - paneShows[i - 1].at) / MIN : 0)).slice(1);
    assert(paneShows.length >= 10, `run-guard told the author "Claude needs you" ${paneShows.length}× in 6 h (every ${between.length ? fmt(between.reduce((a, b) => a + b, 0) / between.length) : "?"} min)`);
    result("RD-3-b", "…6 hours with Claude broken while Gemini and ChatGPT work: alerts and re-checks", "⚠️",
      `the author was notified "Claude needs you" ${paneShows.length} times in 6 h (once, then every ~30 min: notification + taskbar flash + sound) although the book did not need Claude; self-repair re-checked ${rechecks.length} times (at ${rechecks.join(", ")} min: after 5, 15, then every 60 min — each one types a check-in that fails 3 tries, ${sendErrs.length} SEND_NOT_CONFIRMED in all). Nothing changes the state until the author acts.`,
      null, { notifications: paneShows.length, rechecks: rechecks.length, send_errors: sendErrs.length });
  } finally { await rig.stop(); }
}

// =====================================================================================================================
// RD-4: "New chat" does not give an empty chat; the chat grows past ~340 000 characters
// =====================================================================================================================
async function rd4() {
  console.log("\n== RD-4-a ChatGPT's New chat button does not give an empty chat ==");
  let rig = await makeRig({ sites: { chatgpt: { newChatWorks: false, answerMs: 40000, writeMs: 20000, replyChars: 6000 } }, freshChat: { everyRequests: 3 } });
  try {
    const t0 = rig.now();
    for (let i = 0; i < 7; i++) { const a = await rig.akoweAttempt("chatgpt", `run-ice:scenes${i}:c0-chatgpt`, 899000, BOOK); assert(a.ok, `request ${i + 1} answered (${fmt(a.minutes)} min)`); }
    const fc = rig.kinds("akowe-fresh-chat", "chatgpt").filter((e) => e.reason === "requests"); // (the first one, for the new book, is on an empty page)
    const rl = rig.kinds("reload", "chatgpt").filter((e) => e.by === "fresh-chat");
    assert(fc.length >= 2 && fc.every((e) => e.how === "address") && rl.length === fc.length, `every fresh chat: the button is clicked, the chat is not empty, the page is reloaded (${fc.map((e) => e.how).join(", ")})`);
    result("RD-4-a", "ChatGPT's \"New chat\" button does not give an empty chat", "✅",
      `each of the ${fc.length} fresh chats clicked New chat, waited 2.5 s, found the old replies still there and opened the new-chat address instead ("reload by fresh-chat"); the request then went into an empty chat and was answered. Cost: one page reload (+2.5 s) per fresh chat. ${fmt((rig.now() - t0) / MIN)} min for 7 requests.`,
      null, { fresh: fc.length });
  } finally { await rig.stop(); }

  console.log("\n== RD-4-b the same while ChatGPT's replies are unreadable: the fresh-chat check is fooled ==");
  rig = await makeRig({ sites: { chatgpt: { layout: "changed", newChatWorks: false, answerMs: 40000, writeMs: 20000 } }, freshChat: { everyRequests: 1 } });
  try {
    rig.sims.chatgpt.learned.assistant = { selector: 'div[data-turn-role="model"]', how: "page-search", learnedAt: rig.now() };
    await rig.akoweAttempt("chatgpt", "run-ice:a:c0-chatgpt", 899000, BOOK);
    delete rig.sims.chatgpt.learned.assistant; // retired (RD-2): the reader matches nothing again
    const before = rig.sims.chatgpt.chatChars;
    const p = rig.akoweAttempt("chatgpt", "run-ice:b:c0-chatgpt", 300000, BOOK);
    await rig.waitV(() => rig.kinds("akowe-fresh-chat", "chatgpt").length >= 2 || rig.kinds("akowe-fresh-chat-held", "chatgpt").length >= 1, 10 * MIN);
    const fc = rig.kinds("akowe-fresh-chat", "chatgpt").slice(-1)[0];
    const held = rig.kinds("akowe-fresh-chat-held", "chatgpt")[0];
    await p;
    assert(fc && fc.how === "button" && fc.chatCharsLeft === before, `the fresh-chat check counted 0 replies (its reply selectors match nothing) and took the OLD chat for an empty one (how=${fc && fc.how}, ${fc && fc.chatCharsLeft} chars still in the chat)`);
    result("RD-4-b", "…while the reply selector matches nothing: the empty-chat check is fooled", "⚠️",
      `New chat did nothing, but the check "0 replies + a message box" passed because its reply selectors (the same ones that match nothing) found 0 replies: logged as a fresh chat (how=button), the counters were reset, and the prompt went into the old ${Math.round(before / 1000)}k-character chat. The chat keeps growing while AutoInjector believes it is fresh.${held ? ` (held: ${held.held})` : ""}`,
      null);
  } finally { await rig.stop(); }

  console.log("\n== RD-4-c an unread reply keeps the pane 'waiting' -> the fresh chat is held 'busy' and the chat grows ==");
  rig = await makeRig({ scale: 1 / 1000, sites: { chatgpt: { layout: "changed", answerMs: 60000, writeMs: 30000, replyChars: 9000, replyBody: null } } });
  try {
    // the run so far: ChatGPT's chat already holds ~280 000 characters (prompts of ~30 000 + replies)
    const sim = rig.sims.chatgpt;
    for (let i = 0; i < 8; i++) { sim.history.push({ who: "human", text: "p".repeat(26000) }, { who: "bot", text: "r".repeat(9000) }); }
    sim.chatChars = 8 * 35000; sim.build();
    rig.freshChat.noteBook("chatgpt", { id: "proj-ice" }); rig.freshChat.reset("chatgpt"); // this book's chat, opened earlier
    for (let i = 0; i < 8; i++) { rig.freshChat.noteSent("chatgpt", 26000); rig.freshChat.noteReply("chatgpt", 9000); }
    const big = "Write the next scene. " + "context ".repeat(3700);
    const t0 = rig.now();
    const out = [];
    for (const [id, dl] of [["c0", 899000], ["c1", 300000], ["next-c0", 899000]]) {
      const r = await rig.akoweAttempt("chatgpt", `run-ice:scenes_check:${id}-chatgpt`, dl, { prompt: big, book_id: "proj-ice" });
      out.push({ id, status: r.status, chars: sim.chatChars });
    }
    const held = rig.kinds("akowe-fresh-chat-held", "chatgpt");
    const fresh = rig.kinds("akowe-fresh-chat", "chatgpt").length;
    assert(held.length >= 1 && held[0].held === "busy" && fresh === 0, `the fresh chat is due (${held[0] && held[0].reason}, ${held[0] && Math.round(held[0].chars / 1000)}k chars) but held "busy": the unread reply leaves the pane waiting`);
    assert(sim.chatChars > 340000, `the chat grew to ${Math.round(sim.chatChars / 1000)}k characters (${out.map((x) => `${x.id}: ${x.status}, ${Math.round(x.chars / 1000)}k`).join("; ")})`);
    result("RD-4-c", "an unread reply keeps the pane \"waiting\": the fresh chat is held and the chat grows past 340 000 characters", "⚠️",
      `from the 2nd try on the fresh chat was due (${held[0] ? `${held[0].reason}, ${Math.round(held[0].chars / 1000)}k` : "?"}), but main.js freshChatBusy() counts state.waiting — which stays true while no reply is captured — so it was held "busy" (logged once: akowe-fresh-chat-held) and every new prompt went into the same chat: ${out.map((x) => `${Math.round(x.chars / 1000)}k`).join(" → ")} characters in ${fmt((rig.now() - t0) / MIN)} min. A fresh chat (a new page) might even have fixed the reading.`,
      (rig.now() - t0) / MIN, { chars: sim.chatChars });
  } finally { await rig.stop(); }
}

// =====================================================================================================================
// RD-5: the author uses the pane by hand while Akọwe waits
// =====================================================================================================================
async function rd5() {
  console.log("\n== RD-5-a the author chats in ChatGPT's pane: a due fresh chat is held for them ==");
  let rig = await makeRig({ sites: { chatgpt: { answerMs: 40000, writeMs: 20000 } }, freshChat: { everyRequests: 2 } });
  try {
    const out = [];
    for (let i = 0; i < 6; i++) {
      rig.sims.chatgpt.userAt = rig.now() - 60000; // the author typed in that pane a minute ago (before every request)
      const a = await rig.akoweAttempt("chatgpt", `run-ice:review${i}:c0-chatgpt`, 899000, BOOK);
      out.push({ ok: a.ok, chars: rig.sims.chatgpt.chatChars });
    }
    const held = rig.kinds("akowe-fresh-chat-held", "chatgpt");
    const fresh = rig.kinds("akowe-fresh-chat", "chatgpt").length;
    assert(held.length === 1 && held[0].held === "user" && fresh === 0 && out.every((x) => x.ok), `held "user" (logged once), no fresh chat in 6 requests, all answered`);
    result("RD-5-a", "the author keeps using ChatGPT's pane by hand: the due fresh chat is held for them", "✅",
      `held "user" (logged once), so Akọwe's prompts went into the author's chat (${Math.round(out[out.length - 1].chars / 1000)}k chars after 6 requests) and were all answered; the fresh chat waits until the author leaves the pane alone for 10 min (a full chat would still be swapped). By design, no time lost; the chat grows meanwhile.`,
      0);
  } finally { await rig.stop(); }

  console.log("\n== RD-5-b the author asks ChatGPT their own question while Akọwe's prompt waits ==");
  rig = await makeRig({ sites: { chatgpt: { answerMs: 6 * MIN, writeMs: 60000 } } });
  try {
    const t0 = rig.now();
    const p = rig.akoweAttempt("chatgpt", "run-ice:editor:c0-chatgpt", 899000, BOOK);
    await rig.idle(60000);
    // the author types a question by hand (no [MSG #], not in the Relay Trace) and ChatGPT answers it at once,
    // keeping the reply format of the conversation ([TO: USER] … [FROM: CHATGPT]) — web AIs copy it
    const sim = rig.sims.chatgpt;
    sim.userAt = rig.now();
    sim.add("human", "Quick question from me: what is a good synonym for 'frozen'?");
    await rig.idle(20000);
    sim.add("bot", "[TO: USER]\nIcebound, glacial or rimed all work.\n[FROM: CHATGPT]");
    const a = await p;
    await rig.idle(8 * MIN); // Akọwe's real answer lands later
    const last = rig.kinds("captured", "chatgpt").slice(-1)[0];
    const authorsTaken = a.ok && /Icebound/.test(a.json.text);
    assert(authorsTaken, `Akọwe's request was answered with the AUTHOR's chat reply (${a.status}, "${a.ok ? a.json.text.slice(0, 40) : ""}") after ${fmt(a.minutes)} min`);
    assert(last && last.owner === "relay", `the real answer to Akọwe's prompt arrived later and went nowhere (owner ${last && last.owner})`);
    result("RD-5-b", "the author asks ChatGPT their own question in the pane while Akọwe's prompt waits", "❌",
      `ChatGPT answered the author's question first, in the conversation's [TO:]/[FROM:] format; the Relay Trace has only Akọwe's [MSG #] open, so the bridge took the author's chat answer as Akọwe's reply (200 after ${fmt(a.minutes)} min, the same seq). The real answer came ${fmt((last.at - t0) / MIN)} min in and was treated as an ordinary relay reply — lost to Akọwe. Akọwe's JSON check would most likely refuse the text and ask again (a wasted try), but a reply that happens to fit is used. Nothing in AutoInjector checks "the user typed in this pane after the prompt".`,
      a.minutes, {});
  } finally { await rig.stop(); }
}

// =====================================================================================================================
// RD-6: out of the box (from the log)
// =====================================================================================================================
async function rd6() {
  console.log("\n== RD-6-a the author presses 🩺 Check on a stalled ChatGPT while Akọwe waits ==");
  let rig = await makeRig({ sites: { chatgpt: { layout: "changed", answerMs: 60000, writeMs: 20000 } } });
  try {
    const p = rig.akoweAttempt("chatgpt", "run-ice:bible:c0-chatgpt", 899000, BOOK);
    await rig.waitV(() => rig.kinds("capture-stalled", "chatgpt").length > 0, 10 * MIN);
    const t = rig.now();
    const r = rig.selfRepair.probeMany(["chatgpt"], "you-asked", "demand"); // 🩺 (main.js selfrepair:probe)
    const rq = rig.selfRepair.requestCheck("chatgpt", "user");
    const a = await p;
    assert(r.started.length === 0 && r.skipped.chatgpt === "akowe", `🩺 is skipped: "${r.skipped.chatgpt}"; a user check request only queues (${rq})`);
    result("RD-6-a", "the author presses 🩺 Check on the stalled ChatGPT while Akọwe waits", "⚠️",
      `skipped ("${r.skipped.chatgpt}"): even the author cannot start the repair while an Akọwe request (or its late window) is open; the request still ran ${fmt(a.minutes)} min (🩺 pressed at ${fmt((t - (rig.now() - a.minutes * MIN)) / MIN)} min).`,
      a.minutes - (t - (rig.now() - a.minutes * MIN)) / MIN);
  } finally { await rig.stop(); }

  console.log("\n== RD-6-b ChatGPT's page keeps 'writing' (Stop button stuck) ==");
  rig = await makeRig({ sites: { chatgpt: { answerMs: 30000, writeMs: 40 * MIN } } });
  try {
    const t0 = rig.now();
    const a = await rig.akoweAttempt("chatgpt", "run-ice:planned_check:c0-chatgpt", 899000, BOOK);
    const st = firstAt(rig, "capture-stalled", "chatgpt");
    assert(a.status === 504, `504 after ${fmt(a.minutes)} min; capture-stalled ${st ? `at ${fmt((st - t0) / MIN)} min` : "never during the request"}`);
    result("RD-6-b", "ChatGPT's page keeps saying it is writing (Stop button stuck)", "⚠️",
      `pane health calls it "still writing" for 4× the stall time (12 min) before it is a stall (${st ? `logged at ${fmt((st - t0) / MIN)} min` : "not logged"}); the request ran ${fmt(a.minutes)} min to 504; the "unfreeze" repair (press Stop) cannot run while the request is open (busy). Another AI could have answered meanwhile.`,
      a.minutes);
  } finally { await rig.stop(); }

  console.log("\n== RD-6-c a stopped book run waits ~5 h for the author ==");
  {
    let t = Date.UTC(2026, 10, 27, 10, 11);
    const shows = [];
    const n = runGuard.createNotifier({ now: () => t, show: (c) => shows.push({ at: t, again: c.again }) });
    const run = { id: "run-dd6", state: "problem", title: "x", at: 7, total: 19, alert: { key: "TIMEOUT:review", label: "AI problem", category: "ai", code: "TIMEOUT", what: "review", wrong: "The AI did not answer in time", why: "stopped" } };
    for (let m = 0; m <= 300; m++) { n.update(runGuard.conditionsFrom({ run, sites: {}, watching: true })); t += MIN; }
    assert(shows.length === 11, `notified ${shows.length}× in 5 h (once + every 30 min)`);
    result("RD-6-c", "a book run stopped on TIMEOUT waits ~5 h for the author", "⚠️",
      `run-guard notifies ${shows.length}× in 5 h (once, then every 30 min) — the stop itself is Akọwe's (another agent's section); on the desktop side nothing can resume it, and the AIs that work (Gemini, Claude) sit idle meanwhile.`,
      300);
  }
}

// =====================================================================================================================
async function main() {
  const only = (process.env.RD_ONLY || "").split(",").filter(Boolean);
  const want = (id) => !only.length || only.includes(id);
  if (want("1")) await rd1();
  if (want("2")) await rd2();
  if (want("3")) await rd3();
  if (want("4")) await rd4();
  if (want("5")) await rd5();
  if (want("6")) await rd6();
  if (process.env.RD_RESULTS) fs.writeFileSync(process.env.RD_RESULTS, JSON.stringify(RESULTS, null, 2));
  console.log("\nSUMMARY");
  for (const r of RESULTS) console.log(`  ${r.id}  ${r.result}  waited ${r.waited_min == null ? "-" : r.waited_min + " min"}  ${r.scenario}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("stress-realrun: still running after 10 min"); process.exit(1); }, 600000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
