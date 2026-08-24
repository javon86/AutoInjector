// test/run.js — drives the real main.js through its actual IPC handlers with a
// mocked Electron layer (see mock-electron.js), simulating replies and checking
// what gets sent next. Exercises the House Rules state machines and routing
// logic for real; does not (and cannot, without a browser) test the DOM
// automation itself. Run with: node test/run.js
// QA-001: run main.js on a fast, internally-consistent clock so the integration
// suite is quick and deterministic (same logic, smaller timing windows). These
// MUST be set before main.js is required (it reads them at load).
process.env.AUTOINJECTOR_POLL_MS = process.env.AUTOINJECTOR_POLL_MS || "50";
process.env.AUTOINJECTOR_STABLE_MS = process.env.AUTOINJECTOR_STABLE_MS || "80";
process.env.AUTOINJECTOR_RETRY_BACKOFF_MS = process.env.AUTOINJECTOR_RETRY_BACKOFF_MS || "150";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS || "60";
// selftest timeout stays at its default: the tuner tests answer every check
// promptly (so they never idle to it), and shortening it broke the tuner's
// step-by-step choreography. selftest poll is nudged down to match the fast clock.
process.env.AUTOINJECTOR_SELFTEST_POLL_MS = process.env.AUTOINJECTOR_SELFTEST_POLL_MS || "100";
// End-tag protocol: shrink the missing-[FROM:]-tag watchdog so the resend-nudge
// test runs on the fast clock. Baseline replies complete on their tag instantly,
// so this only affects deliberately-untagged replies (sayRaw).
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = process.env.AUTOINJECTOR_NOTAG_QUIET_MS || "300";

const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
const automation = require(path.join(__dirname, "..", "automation"));

// The manager loop's HTTP boundary (manager-provider.js's askManager) gets
// stubbed the same way Electron itself does here -- main.js's own
// `const managerProvider = require("./manager-provider")` resolves to this
// exact same module-cache entry, so overwriting its export intercepts every
// call main.js makes without touching main.js at all. testConnection()'s
// internal call to the real askManager (a separate closured reference) is
// deliberately NOT intercepted -- see testManagerConfigureAndConnection().
const managerProvider = require(path.join(__dirname, "..", "manager-provider"));
let managerAskQueue = []; // strict FIFO -- one entry consumed per call, exactly the sequence a test queued
let managerAskRepeat = null; // falls back to this (without consuming it) once the FIFO queue is empty
let managerAskCalls = [];
managerProvider.askManager = async (managerState, config) => {
  managerAskCalls.push({ managerState, config });
  if (managerAskQueue.length) return managerAskQueue.shift();
  if (managerAskRepeat) return managerAskRepeat;
  return { ok: false, error: "NO_STUB_QUEUED" };
};
function queueManagerDecision(decision) { managerAskQueue.push({ ok: true, decision }); }
function queueManagerDecisionRepeating(decision) { managerAskRepeat = { ok: true, decision }; }
function resetManagerStub() { managerAskQueue = []; managerAskRepeat = null; managerAskCalls = []; }

const SITES = ["chatgpt", "claude", "gemini"];
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function reg(site) { return mockElectron.__registry[site]; }
function sentLog(site) { return reg(site).webContents.sentLog; }
function totalSent() { return SITES.reduce((n, s) => n + sentLog(s).length, 0); }

// A bounded "nothing more happened" margin for NEGATIVE assertions, anchored to
// the (fast) test clock — comfortably longer than a poll tick, the stability
// debounce, and a retry backoff, so a delayed send would have fired by now.
const SETTLE_MS = Number(process.env.AUTOINJECTOR_SETTLE_MS) || 400;
function settle(ms) { return new Promise((r) => setTimeout(r, ms == null ? SETTLE_MS : ms)); }

async function waitUntil(fn, { timeout = 10000, interval = 150, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await fn(); // await handles both sync and async predicates correctly
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, interval));
  }
  console.log(`  ... timed out waiting for: ${label}`);
  return null;
}

function call(channel, payload) {
  const h = mockElectron.__ipcHandlers[channel];
  if (!h) throw new Error(`no ipc handler registered for "${channel}"`);
  return h({}, payload);
}

async function resetAllParticipants() {
  await call("houserule:stop", {}); // defensive: don't let a stuck prior scenario block the next start
  for (const s of SITES) {
    await call("participants:set", { site: s, enabled: true });
    await call("site:reload", s); // resets main.js's own pending/captured read-state for this site
    reg(s).webContents.currentText = "";
    reg(s).webContents.sentLog = [];
  }
  await call("transcript:clear", {});
  await settle(200); // let any in-flight poll tick from the prior scenario drain
}

// Every baseline reply now completes on its [FROM: X] closing tag (end-tag
// protocol). say() auto-appends the sender's tag unless the injected text already
// carries one, so existing scenarios keep working unchanged. Use sayRaw() to
// inject a deliberately untagged reply (e.g. the missing-tag watchdog test).
function fromTag(site) { return `[FROM: ${site.toUpperCase()}]`; }
function say(site, text) {
  const t = /\[\s*FROM:/i.test(text) ? text : `${text}\n${fromTag(site)}`;
  reg(site).webContents.currentText = t;
}
function sayRaw(site, text) { reg(site).webContents.currentText = text; }

async function testDebate() {
  console.log("\n== Debate: 3 participants, 2 rounds ==");
  await resetAllParticipants();
  const startRes = await call("houserule:start", { mode: "debate", topic: "Is TDD worth it?", rounds: 2 });
  assert(startRes.ok, "starts successfully");

  // Each site's own sentLog only grows when THAT site is the one addressed —
  // turn 2 goes to a different participant, whose count is 1, not 2 — so track
  // per-site counts and diff them, rather than assuming a shared turn counter.
  const counts = () => Object.fromEntries(SITES.map((s) => [s, sentLog(s).length]));
  const zero = Object.fromEntries(SITES.map((s) => [s, 0]));
  const findChanged = (before, after) => SITES.find((s) => after[s] > before[s]);

  let prev = counts();
  let speaker = findChanged(zero, prev);
  if (!assert(!!speaker, "kickoff sent to exactly one participant")) return;
  const order = [speaker];

  for (let i = 0; i < 5; i++) {
    say(speaker, `stance #${i + 1} from ${speaker}`);
    const before = prev;
    const after = await waitUntil(() => {
      const now = counts();
      return findChanged(before, now) ? now : null;
    }, { label: `turn ${i + 2} to be sent` });
    if (!assert(!!after, `turn ${i + 2}: someone new received a message`)) break;
    speaker = findChanged(before, after);
    order.push(speaker);
    prev = after;
  }

  // turn 6 (last of round 2) should end the debate — nobody else gets sent anything after
  say(speaker, "stance #6 final");
  await waitUntil(async () => (await call("state:get", {})).houseRule.active === false, { label: "debate to end after final round" });
  await settle(250); // settle margin to catch any stray extra send
  assert(JSON.stringify(counts()) === JSON.stringify(prev), "no further message sent after the configured rounds complete");

  assert(order.length === 6, `captured all 6 turns (got ${order.length})`);
  assert(new Set(order).size === 3, `speaking order covered all 3 participants (got: ${order.join(", ")})`);
  const state1 = await call("state:get", {});
  assert(state1.houseRule.active === false, "debate marked inactive once rounds are done");
  assert(state1.houseRule.roundNum === 2, `roundNum is 2 (got ${state1.houseRule.roundNum})`);
}

async function testDevilAngel() {
  console.log("\n== Devil & Angel: role isolation + fan-in ==");
  await resetAllParticipants();
  const startRes = await call("houserule:start", { mode: "devil-angel", topic: "Launch the product now", rounds: 1 });
  assert(startRes.ok, "starts successfully");

  const state0 = await call("state:get", {});
  const roles = state0.houseRule.roles;
  const middle = Object.keys(roles).find((s) => roles[s] === "middle");
  const devil = Object.keys(roles).find((s) => roles[s] === "devil");
  const angel = Object.keys(roles).find((s) => roles[s] === "angel");
  assert(middle && devil && angel && new Set([middle, devil, angel]).size === 3, "exactly one Middle, Devil and Angel, all different sites");

  await waitUntil(() => sentLog(middle).length === 1, { label: "middle gets the opening prompt" });
  assert(sentLog(devil).length === 0 && sentLog(angel).length === 0, "devil/angel get nothing until middle speaks");

  say(middle, "We should ship it Friday.");
  await waitUntil(() => sentLog(devil).length === 1 && sentLog(angel).length === 1, { label: "middle's statement fans out to both" });
  assert(sentLog(devil)[0].text.includes("Middle says"), "devil's message is framed as coming from Middle");
  assert(sentLog(devil)[0].text.toLowerCase().includes("devil"), "devil's first message explains its role");
  assert(!sentLog(devil)[0].text.includes(sentLog(angel)[0].text), "devil's message doesn't contain angel's message (they can't see each other)");

  say(devil, "This will break under load, no rollback plan.");
  await settle();
  assert(sentLog(middle).length === 1, "middle hasn't been messaged yet — still waiting on angel too");

  say(angel, "The team is ready, customers are asking for this.");
  await waitUntil(() => sentLog(middle).length === 2, { label: "middle gets the combined fan-in message" });
  const combined = sentLog(middle)[1].text;
  assert(combined.includes("Devil says") && combined.includes("Angel says"), "middle's 2nd message contains BOTH devil's and angel's points combined into one send");

  const midRun = await call("state:get", {});
  assert(midRun.houseRule.active === true, "still running — middle hasn't responded to the feedback yet, so 'rounds:1' shouldn't have ended it early");

  say(middle, "Fair points both ways — we'll ship with a rollback plan ready.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.active === false, { label: "run to end once middle delivers its synthesis" });
  assert(sentLog(devil).length === 1 && sentLog(angel).length === 1, "devil/angel are NOT re-consulted a second time — rounds:1 means exactly one fan-out cycle");
}

async function testChargeback() {
  console.log("\n== Chargeback: referee stays silent, 1-round verdict ==");
  await resetAllParticipants();
  const startRes = await call("houserule:start", { mode: "chargeback", topic: "Remote work beats office work", rounds: 1 });
  assert(startRes.ok, "starts successfully");

  const state0 = await call("state:get", {});
  const roles = state0.houseRule.roles;
  const d1 = Object.keys(roles).find((s) => roles[s] === "debater1");
  const d2 = Object.keys(roles).find((s) => roles[s] === "debater2");
  const referee = Object.keys(roles).find((s) => roles[s] === "referee");
  assert(d1 && d2 && referee, "roles assigned: debater1, debater2, referee");

  await waitUntil(() => sentLog(d1).length === 1 && sentLog(referee).length === 1, { label: "kickoff sent to debater1 and referee" });

  say(referee, "Understood, watching silently.");
  await settle();
  const state1 = await call("state:get", {});
  assert(state1.houseRule.active === true, "referee's acknowledgment does not end or advance the run");

  say(d1, "Remote work removes commute time entirely.");
  await waitUntil(() => sentLog(d2).length === 1, { label: "debater1's opening forwarded to debater2" });
  const refCopiesAfterD1 = sentLog(referee).length;
  assert(refCopiesAfterD1 === 2, `referee got an informational copy of debater1's statement (sentLog=${refCopiesAfterD1})`);

  say(referee, "Noted.");
  await settle();

  say(d2, "But it kills spontaneous collaboration.");
  // Round is configured for 1, so this should trigger the combined final-message + verdict request to referee
  await waitUntil(() => sentLog(referee).length === refCopiesAfterD1 + 1, { label: "final combined message sent to referee" });
  assert(sentLog(referee).length === 3, "referee received exactly 3 sends total (kickoff, one informational copy, one combined final+verdict) — not 4, confirming the two final-round messages were folded into one");
  assert(sentLog(referee)[2].text.includes("deliver your verdict"), "the combined final message actually asks for a verdict");
  assert(sentLog(referee)[2].text.includes("debater2") === false, "sanity: message is plain text, not literally the word debater2");

  say(referee, "Debater 1 made the stronger case. Winner: Debater 1.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.active === false, { label: "verdict ends the run" });
  const transcript = (await call("state:get", {})).transcript;
  const verdictTurn = transcript.find((t) => t.isVerdict);
  assert(!!verdictTurn, "the verdict reply is marked isVerdict in the transcript");
}

async function testWhoWantsToSpeak() {
  console.log("\n== Who Wants to Speak?: only opt-ins get a real turn ==");
  await resetAllParticipants();
  const startRes = await call("houserule:start", { mode: "who-wants-to-speak", topic: "Best way to learn a language", rounds: 1 });
  assert(startRes.ok, "starts successfully");

  await waitUntil(() => SITES.every((s) => sentLog(s).length === 1), { label: "opt-in check sent to all 3" });

  say("chatgpt", "YES — immersion beats textbooks.");
  say("claude", "NO");
  say("gemini", "yes, spaced repetition matters too");

  await waitUntil(() => sentLog("chatgpt").length === 2 && sentLog("gemini").length === 2, { label: "opted-in sites get the real follow-up" });
  await settle();
  assert(sentLog("claude").length === 1, "claude (said NO) never gets a second message");
  assert(sentLog("chatgpt")[1].text.toLowerCase().includes("go ahead"), "follow-up prompt is the real 'give your point' ask");
}

async function testFreeForAllAndBrainstormTeardown() {
  console.log("\n== Free-for-All + Brainstorm: mesh setup and teardown ==");
  await resetAllParticipants();
  await call("houserule:start", { mode: "free-for-all", topic: "Best pizza topping", rounds: 0 });
  let g = (await call("state:get", {})).global;
  assert(SITES.every((s) => g.routing[s].length === 2), "free-for-all sets up full mesh routing (each site -> both others)");

  const stopRes = await call("houserule:stop", {});
  assert(stopRes.ok, "houserule:stop succeeds");
  assert(SITES.every((s) => stopRes.global.routing[s].length === 0), "BUGFIX: houserule:stop actually clears the mesh routing it set up");

  await resetAllParticipants();
  await call("houserule:start", { mode: "brainstorm", topic: "Name for a coffee shop", rounds: 0 });
  await call("houserule:wrap-up-brainstorm", {});
  const state1 = await call("state:get", {});
  const synth = Object.keys(state1.houseRule.roles).find((s) => state1.houseRule.roles[s] === "synthesizer");
  assert(!!synth, "wrap-up assigns exactly one synthesizer");
  say(synth, "Final answer: The Daily Grind.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.active === false, { label: "synthesis reply ends brainstorm" });
  const transcript = (await call("state:get", {})).transcript;
  assert(!!transcript.find((t) => t.isFinalPlan), "the synthesis reply is marked isFinalPlan in the transcript");
}

async function testParticipantDisableRemovesAsTarget() {
  console.log("\n== Bugfix regression: disabling a participant removes it as a target too ==");
  await resetAllParticipants();
  await call("routing:auto-all", {});
  let g = (await call("state:get", {})).global;
  assert(g.routing.claude.includes("chatgpt") && g.routing.chatgpt.includes("claude"), "full mesh set up as a baseline");

  await call("participants:set", { site: "claude", enabled: false });
  g = (await call("state:get", {})).global;
  assert(!g.routing.chatgpt.includes("claude"), "BUGFIX: chatgpt no longer routes to disabled claude");
  assert(!g.routing.gemini.includes("claude"), "BUGFIX: gemini no longer routes to disabled claude");
  assert(g.routing.claude.length === 0, "claude's own outgoing routing is also cleared");
}

async function testRotation() {
  console.log("\n== Rotation: fixed ChatGPT -> Claude -> Gemini order, UPDATE hidden from transcript ==");
  await resetAllParticipants();
  const startRes = await call("houserule:start", { mode: "rotation", topic: "Let's discuss the future of AI", rounds: 0 });
  assert(startRes.ok, "starts successfully");
  assert(sentLog("chatgpt").length === 1 && sentLog("chatgpt")[0].text === "Let's discuss the future of AI", "ChatGPT (order[0]) gets the raw topic, unwrapped");

  const state0 = await call("state:get", {});
  assert(state0.houseRule.nextSpeaker === "chatgpt", "before any reply, nextSpeaker is chatgpt (awaiting-first)");

  say("chatgpt", "ChatGPT's opening reply");
  await waitUntil(() => sentLog("claude").length === 1 && sentLog("gemini").length === 1, { label: "chatgpt's reply fans out RESPOND to claude, UPDATE to gemini" });
  assert(sentLog("claude")[0].text.includes("[ChatGPT says]") && sentLog("claude")[0].text.includes("Respond to this, continuing"), "claude gets the RESPOND-framed message");
  assert(sentLog("gemini")[0].text.includes("[ChatGPT says]") && sentLog("gemini")[0].text.includes("reply with exactly: UPDATED"), "gemini gets the UPDATE-framed message instructing it not to join yet");

  const state1 = await call("state:get", {});
  assert(state1.houseRule.nextSpeaker === "claude", "after chatgpt speaks, nextSpeaker is claude");

  say("gemini", "UPDATED");
  await settle();
  const afterUpdateAck = await call("state:get", {});
  assert(afterUpdateAck.transcript.every((t) => t.text !== "UPDATED"), "gemini's 'UPDATED' ack never lands in the transcript");
  assert(sentLog("claude").length === 1 && sentLog("chatgpt").length === 1, "gemini's silent ack doesn't trigger any further sends");

  say("claude", "Claude's reply responding to chatgpt");
  await waitUntil(() => sentLog("gemini").length === 2 && sentLog("chatgpt").length === 2, { label: "claude's reply fans out RESPOND to gemini, UPDATE to chatgpt" });
  assert(sentLog("gemini")[1].text.includes("Respond to this, continuing"), "gemini gets a real RESPOND turn this time");
  assert(sentLog("chatgpt")[1].text.includes("reply with exactly: UPDATED"), "chatgpt gets UPDATEd since it's not its turn");

  say("chatgpt", "UPDATED");
  await settle();

  say("gemini", "Gemini's reply, closing the loop");
  await waitUntil(() => sentLog("chatgpt").length === 3 && sentLog("claude").length === 2, { label: "gemini's reply fans out RESPOND to chatgpt, UPDATE to claude" });
  assert(sentLog("chatgpt")[2].text.includes("Respond to this, continuing"), "rotation wraps back around to chatgpt (RESPOND), completing the fixed cycle");
  assert(sentLog("claude")[1].text.includes("reply with exactly: UPDATED"), "claude gets UPDATEd on the wrap-around");

  const finalState = await call("state:get", {});
  const visible = finalState.transcript.map((t) => t.text);
  assert(visible.includes("ChatGPT's opening reply") && visible.includes("Claude's reply responding to chatgpt") && visible.includes("Gemini's reply, closing the loop"), "all 3 real replies are visible in the transcript");
  assert(!visible.some((t) => t === "UPDATED"), "no 'UPDATED' acknowledgment ever appears in the visible transcript");
  assert(finalState.houseRule.roundNum === 2, `roundNum tracks completed RESPOND turns after the kickoff (got ${finalState.houseRule.roundNum})`);

  const dupStart = await call("houserule:start", { mode: "rotation", topic: "anything", rounds: 0 });
  assert(!dupStart.ok && dupStart.error === "ALREADY_RUNNING", "can't start a new run while rotation is still active");

  await call("houserule:stop", {});
}

async function testBlindRound() {
  console.log("\n== Blind Round: all three get the same question at once, none see any answer until all three have answered, then each sees the OTHER two's independent answers ==");
  await resetAllParticipants();

  await call("participants:set", { site: "gemini", enabled: false });
  const tooFew = await call("houserule:start", { mode: "blind-round", topic: "Should we use microservices?" });
  assert(!tooFew.ok && tooFew.error === "NEEDS_EXACTLY_THREE", "refuses to start with fewer than 3 participants enabled");
  await call("participants:set", { site: "gemini", enabled: true });
  await resetAllParticipants();

  const startRes = await call("houserule:start", { mode: "blind-round", topic: "Should we use microservices?" });
  assert(startRes.ok, "starts successfully with all 3 enabled");
  assert(SITES.every((s) => sentLog(s).length === 1), "all three get the question in the SAME kickoff, not staggered");
  assert(SITES.every((s) => sentLog(s)[0].text.includes("Should we use microservices?") && sentLog(s)[0].text.includes("independently")), "each site's prompt is framed as an independent ask, not a relay of anyone else's view");

  say("chatgpt", "Yes, for the isolation and independent scaling.");
  let s = await waitUntil(async () => {
    const st = await call("state:get", {});
    return !st.houseRule.pendingReplies.includes("chatgpt") ? st : null;
  }, { label: "chatgpt's independent answer is captured and removed from pendingReplies" });
  assert(!!s, "capture actually happened within the timeout");
  assert(SITES.every((site) => sentLog(site).length === 1), "chatgpt answering FIRST does not get shown to claude or gemini yet -- nobody's seen anyone else's answer");
  assert(s.houseRule.active === true, "still running -- only 1 of 3 have answered");
  assert(s.houseRule.pendingReplies.includes("claude") && s.houseRule.pendingReplies.includes("gemini") && !s.houseRule.pendingReplies.includes("chatgpt"), "pendingReplies reflects exactly who's left to answer");

  say("gemini", "No, the operational overhead isn't worth it at our scale.");
  s = await waitUntil(async () => {
    const st = await call("state:get", {});
    return !st.houseRule.pendingReplies.includes("gemini") ? st : null;
  }, { label: "gemini's independent answer is captured and removed from pendingReplies" });
  assert(!!s, "capture actually happened within the timeout");
  assert(SITES.every((site) => sentLog(site).length === 1), "still nothing revealed with 2 of 3 in -- claude hasn't answered yet");
  assert(s.houseRule.pendingReplies.length === 1 && s.houseRule.pendingReplies[0] === "claude", "only claude is left pending now");

  say("claude", "It depends on team size and deployment maturity.");
  await waitUntil(() => SITES.every((s) => sentLog(s).length === 2), { label: "the reveal goes out to all three once the last (claude's) independent answer lands" });

  const chatgptReveal = sentLog("chatgpt")[1].text;
  assert(chatgptReveal.includes("Gemini's independent answer") && chatgptReveal.includes("operational overhead isn't worth it"), "chatgpt's reveal includes gemini's independent answer, correctly labeled");
  assert(chatgptReveal.includes("Claude's independent answer") && chatgptReveal.includes("depends on team size"), "chatgpt's reveal includes claude's independent answer too");
  assert(!chatgptReveal.includes("isolation and independent scaling"), "chatgpt's OWN reveal does not include its own answer echoed back to it");

  const claudeReveal = sentLog("claude")[1].text;
  assert(claudeReveal.includes("isolation and independent scaling") && claudeReveal.includes("operational overhead isn't worth it"), "claude's reveal includes both chatgpt's and gemini's independent answers");
  assert(!claudeReveal.includes("depends on team size"), "claude's OWN reveal does not include its own answer");

  s = await call("state:get", {});
  assert(s.houseRule.active === false, "the run ends itself automatically once the reveal goes out -- it's single-round by design");

  const visible = s.transcript.map((t) => t.text);
  assert(visible.includes("Yes, for the isolation and independent scaling.") && visible.includes("No, the operational overhead isn't worth it at our scale.") && visible.includes("It depends on team size and deployment maturity."), "all three independent answers are visible in the transcript");
}

async function testPauseResume() {
  console.log("\n== Pause/Resume: routing round-trips correctly ==");
  await resetAllParticipants();
  await call("houserule:start", { mode: "free-for-all", topic: "Best pizza topping", rounds: 0 });
  const running = await call("state:get", {});
  assert(SITES.every((s) => running.global.routing[s].length === 2), "free-for-all's full mesh is set up as a baseline");
  assert(running.houseRule.active === true && running.houseRule.paused === false, "freshly started run is active, not paused");

  const pauseRes = await call("houserule:pause", {});
  assert(pauseRes.ok, "pause succeeds");
  assert(SITES.every((s) => pauseRes.global.routing[s].length === 0), "pausing clears live routing so nothing keeps forwarding");
  assert(pauseRes.global.meshActive === false, "meshActive turned off while paused");
  assert(pauseRes.houseRule.active === false && pauseRes.houseRule.paused === true, "houseRule reports active:false, paused:true");
  assert(pauseRes.houseRule.mode === "free-for-all", "mode is preserved across pause, not reset");

  const startWhilePaused = await call("houserule:start", { mode: "brainstorm", topic: "x", rounds: 0 });
  assert(!startWhilePaused.ok && startWhilePaused.error === "ALREADY_RUNNING", "can't start a new run while the current one is only paused");

  const resumeRes = await call("houserule:resume", {});
  assert(resumeRes.ok, "resume succeeds");
  assert(SITES.every((s) => resumeRes.global.routing[s].length === 2), "resuming restores the exact routing that was active before pause");
  assert(resumeRes.global.meshActive === true, "meshActive restored on resume");
  assert(resumeRes.houseRule.active === true && resumeRes.houseRule.paused === false, "houseRule reports active:true, paused:false after resume");

  await call("houserule:stop", {});
}

async function testRoleInjection() {
  console.log("\n== Role Assignment: custom persona clause injected generically ==");
  await resetAllParticipants();

  const setRes = await call("roles:set", { site: "claude", role: "Skeptical Engineer" });
  assert(setRes.ok && setRes.global.customRole.claude === "Skeptical Engineer", "role stored for claude");

  await call("send:compose", { text: "What do you think of this plan?", targets: ["claude"] });
  const sent = sentLog("claude");
  assert(sent[sent.length - 1].text.startsWith("(You're playing the role of: Skeptical Engineer. Keep that in mind in your reply.)"), "role clause is prepended to a plain compose send");
  assert(sent[sent.length - 1].text.includes("What do you think of this plan?"), "original message text still follows the role clause");

  assert(sentLog("chatgpt").length === 0 || !sentLog("chatgpt").some((s) => s.text.includes("Skeptical Engineer")), "role assignment doesn't leak to a different, unassigned site");

  const clearRes = await call("roles:set", { site: "claude", role: "" });
  assert(clearRes.ok && clearRes.global.customRole.claude === "", "role can be cleared back to general-purpose");
  await call("send:compose", { text: "Second message, no role now.", targets: ["claude"] });
  const sent2 = sentLog("claude");
  assert(!sent2[sent2.length - 1].text.includes("playing the role of"), "no role clause once cleared");
}

async function testWindowCollapse() {
  console.log("\n== Window collapse: shrinks to a titlebar in place, restores exactly on expand ==");
  const automationWin = mockElectron.__windowRegistry["AutoInjector Desktop — Automation"];
  assert(!!automationWin, "the real BaseWindow is reachable via the mock registry");

  const before = await call("window:toggle-collapse", { which: "bogus" });
  assert(!before.ok && before.error === "NO_WINDOW", "an unknown window id is rejected cleanly");

  const origBounds = automationWin.getBounds();
  const collapseRes = await call("window:toggle-collapse", { which: "automation" });
  assert(collapseRes.ok && collapseRes.collapsed === true, "first toggle collapses the Automation window");
  const collapsedBounds = automationWin.getBounds();
  assert(collapsedBounds.height === 44, `height shrinks to the titlebar height (got ${collapsedBounds.height})`);
  assert(collapsedBounds.x === origBounds.x && collapsedBounds.y === origBounds.y && collapsedBounds.width === origBounds.width, "position and width stay exactly where they were — it collapses in place, not somewhere else");

  const expandRes = await call("window:toggle-collapse", { which: "automation" });
  assert(expandRes.ok && expandRes.collapsed === false, "second toggle expands it back");
  const restoredBounds = automationWin.getBounds();
  assert(JSON.stringify(restoredBounds) === JSON.stringify(origBounds), "expanding restores the exact original bounds, not just 'some' larger size");

  assert(!mockElectron.__windowRegistry["AutoInjector — Conversation"], "the Conversation window no longer exists at all — everything lives in the Automation window now");
}

async function testRateLimitAutoPause() {
  console.log("\n== Rate-limit detection: auto-pauses instead of cascading a usage-cap message ==");
  await resetAllParticipants();
  await call("houserule:start", { mode: "rotation", topic: "Let's talk about renewable energy", rounds: 0 });
  await waitUntil(() => sentLog("chatgpt").length === 1, { label: "kickoff sent" });

  say("chatgpt", "You've reached your usage limit for GPT-4. Try again later or upgrade your plan.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.active === false, { label: "run auto-pauses on a rate-limit-looking reply" });

  const state1 = await call("state:get", {});
  assert(state1.houseRule.paused === true, "run is marked paused (not stopped) so Resume is available once the limit clears");
  assert(state1.houseRule.pauseReason === "rate-limit", "pauseReason explains why it paused automatically");
  assert(sentLog("claude").length === 0 && sentLog("gemini").length === 0, "the rate-limit message was NOT relayed to the other AIs as if it were a real reply");
  const turn = state1.transcript.find((t) => t.site === "chatgpt");
  assert(!!turn && turn.isRateLimited === true, "the turn is still visible in the transcript, marked isRateLimited, so the user can see what actually happened");

  await call("houserule:stop", {});
}

async function testRateLimitDetectedOutsideHouseRules() {
  console.log("\n== Rate-limit detection: also catches a usage-cap message during plain Auto-routing, not just House Rules ==");
  await resetAllParticipants();
  await call("routing:auto-all", {});
  let g = (await call("state:get", {})).global;
  assert(g.routing.claude.includes("chatgpt") && g.routing.gemini.includes("chatgpt"), "full mesh routing set up as a baseline, no House Rule active");

  say("chatgpt", "You've reached your usage limit for GPT-4. Try again later or upgrade your plan.");
  await waitUntil(async () => (await call("state:get", {})).transcript.some((t) => t.site === "chatgpt" && t.isRateLimited), { label: "the rate-limit reply is captured and marked" });

  const s = await call("state:get", {});
  assert(sentLog("claude").length === 0 && sentLog("gemini").length === 0, "the rate-limit message was NOT relayed through plain Auto-routing either, even though a mesh was fully wired up");
  assert(s.houseRule.active === false && s.houseRule.paused === false, "there's no House Rule to pause -- nothing structured gets touched outside one");
  g = s.global;
  assert(g.routing.claude.includes("chatgpt") && g.routing.gemini.includes("chatgpt"), "the mesh routing itself is left alone (not cleared) outside a House Rule run");
  assert(s.log.some((l) => l.kind === "rate-limit-detected" && l.detail.site === "chatgpt" && l.detail.houseRuleActive === false), "the Activity Log records the detection and that no House Rule was active for it");

  await call("routing:stop-all", {});
}

async function testWaitingSinceTracking() {
  console.log("\n== waitingSince: tracks when a send started waiting, clears once captured ==");
  await resetAllParticipants();
  await call("send:compose", { text: "Quick question", targets: ["chatgpt"] });
  let g = (await call("state:get", {})).global;
  assert(typeof g.waitingSince.chatgpt === "number" && g.waitingSince.chatgpt > 0, "waitingSince is set to a timestamp once a send goes out");

  say("chatgpt", "Quick answer.");
  await waitUntil(async () => !(await call("state:get", {})).global.waiting.chatgpt, { label: "waiting clears once the reply is captured" });
  g = (await call("state:get", {})).global;
  assert(g.waitingSince.chatgpt === null, "waitingSince is cleared back to null once the reply lands, not left stale");
}

async function testConcurrentSendsToSameTargetAreSerialized() {
  console.log("\n== sendTextTo: two concurrent sends to the SAME target are serialized, not raced (the real cause of the ~50% SEND_NOT_CONFIRMED rate seen under mesh routing) ==");
  await resetAllParticipants();

  // gemini's first send is artificially slow (300ms), its second is
  // instant (0ms) -- if the two calls were allowed to race unserialized,
  // the FASTER second call would finish (and land in sentLog) before the
  // slower first one, landing out of order. If they're properly queued,
  // the second call's script doesn't even START until the first's finishes,
  // so the order (and roughly the combined timing) is preserved regardless
  // of which one is individually "faster".
  reg("gemini").webContents._sendDelayQueue = [300, 0];
  const start = Date.now();
  const pA = call("send:compose", { text: "Message A (slow)", targets: ["gemini"] });
  const pB = call("send:compose", { text: "Message B (fast)", targets: ["gemini"] });
  await Promise.all([pA, pB]);
  const elapsed = Date.now() - start;

  const log = sentLog("gemini");
  assert(log.length === 2, `both sends landed (got ${log.length})`);
  assert(log[0].text === "Message A (slow)" && log[1].text === "Message B (fast)", `FIFO order is preserved even though B was individually faster than A -- got [${log.map((e) => e.text).join(", ")}]`);
  assert(elapsed >= 290, `the two sends actually ran one after another (~300ms+ total), not in parallel (took ${elapsed}ms)`);
}

async function testSendAutoRetry() {
  console.log("\n== sendTextTo: a failed send is retried automatically (up to 3 total attempts) before ever being reported as a failure ==");
  await resetAllParticipants();

  // fails twice, then succeeds on the 3rd (real) attempt -- self-recovers
  // without the caller ever seeing a failure
  reg("claude").webContents._sendFailQueue = [true, true, false];
  const res = await call("send:compose", { text: "Should self-recover", targets: ["claude"] });
  assert(res.ok && res.results.claude.ok, "the overall call still succeeds -- the caller never sees the two earlier failures");
  assert(sentLog("claude").length === 1 && sentLog("claude")[0].text === "Should self-recover", "exactly one real send lands (the successful 3rd attempt), not three separate messages");

  let s = await call("state:get", {});
  assert(s.log.some((l) => l.kind === "send-retry" && l.detail.target === "claude" && l.detail.attempt === 1) && s.log.some((l) => l.kind === "send-retry" && l.detail.target === "claude" && l.detail.attempt === 2), "both earlier failed attempts are logged as retries, individually");
  assert(s.log.some((l) => l.kind === "sent" && l.detail.target === "claude" && l.detail.attempts === 3 && l.detail.selfRecovered === true), "the final success is logged with the real attempt count and flagged as self-recovered, not indistinguishable from a clean first try");

  const ledgerEntry = s.ledger.filter((e) => e.target === "claude" && e.textPreview === "Should self-recover").pop();
  assert(ledgerEntry && ledgerEntry.status === "delivered" && ledgerEntry.attempts === 3, `the delivery ledger also records the real attempt count for the successful entry (got ${JSON.stringify(ledgerEntry)})`);

  // fails all 3 attempts -- genuinely reported as broken, not retried forever
  await resetAllParticipants();
  reg("gemini").webContents._sendFailQueue = [true, true, true];
  const start = Date.now();
  const failRes = await call("send:compose", { text: "Genuinely broken", targets: ["gemini"] });
  const elapsed = Date.now() - start;
  assert(!failRes.results.gemini.ok && failRes.results.gemini.error === "SEND_NOT_CONFIRMED", "after all 3 attempts fail, it's reported as a real failure, not silently swallowed");
  assert(sentLog("gemini").length === 0, "nothing ever actually landed -- all 3 attempts genuinely failed, not a partial success");
  const twoBackoffs = 2 * Number(process.env.AUTOINJECTOR_RETRY_BACKOFF_MS || 1500);
  assert(elapsed >= twoBackoffs * 0.9, `all 3 attempts actually ran, backing off between each (~${twoBackoffs}ms for 2 backoffs), not fast-failing after one try (took ${elapsed}ms)`);

  s = await call("state:get", {});
  const failLedgerEntry = s.ledger.filter((e) => e.target === "gemini" && e.textPreview === "Genuinely broken").pop();
  assert(failLedgerEntry && failLedgerEntry.status === "failed" && failLedgerEntry.attempts === 3, "the ledger records the real attempt count (3) even for a total failure, not left at 1");
  assert(s.log.some((l) => l.kind === "send-error" && l.detail.target === "gemini" && l.detail.attempts === 3), "the final send-error log entry also carries the real attempt count");
}

async function testDeliveryLedger() {
  console.log("\n== Delivery ledger: the program's own record of what was actually sent where, independent of what any AI believes happened ==");
  await resetAllParticipants();

  const before = (await call("state:get", {})).ledger.length;
  const composeRes = await call("send:compose", { text: "Ledger test message", targets: ["claude"] });
  assert(composeRes.ok, "the underlying send still succeeds normally");
  let s = await call("state:get", {});
  let entries = s.ledger.slice(before);
  assert(entries.length === 1, `exactly one ledger entry was recorded for the one send (got ${entries.length})`);
  const entry = entries[0];
  assert(entry.target === "claude" && entry.source === null && entry.status === "delivered" && entry.error === null, `a successful compose (no fromSite) is recorded as delivered with no error and source:null (got ${JSON.stringify(entry)})`);
  assert(entry.textPreview.includes("Ledger test message"), "the ledger records what was actually sent, not just that something was");
  assert(typeof entry.id === "string" && entry.id.startsWith("MSG-"), "each entry gets its own program-assigned message id, never something an AI could claim to have invented");
  assert(entry.duplicate === false, "a first-of-its-kind send isn't flagged as a duplicate");

  // a relayed send (fromSite set) records the real source, not null
  reg("claude").webContents._forceSendFail = false;
  say("chatgpt", "[TO: GEMINI]\nRelay this specific one.");
  await waitUntil(async () => {
    const st = await call("state:get", {});
    return st.ledger.some((e) => e.target === "gemini" && e.textPreview.includes("Relay this specific one"));
  }, { label: "the tag-routed relay to gemini gets its own ledger entry" });
  s = await call("state:get", {});
  const relayed = s.ledger.find((e) => e.target === "gemini" && e.textPreview.includes("Relay this specific one"));
  assert(relayed.source === "chatgpt", "a relayed send records the ACTUAL originating site as source, not left null or trusted from anything inside the message text");

  // a failed send is still recorded, with the real error, not silently dropped
  await resetAllParticipants();
  const beforeFail = (await call("state:get", {})).ledger.length;
  reg("chatgpt").webContents._forceSendFail = true;
  await call("send:compose", { text: "This one will fail", targets: ["chatgpt"] });
  reg("chatgpt").webContents._forceSendFail = false;
  s = await call("state:get", {});
  const failEntry = s.ledger.slice(beforeFail).find((e) => e.target === "chatgpt");
  assert(!!failEntry && failEntry.status === "failed" && failEntry.error === "SEND_NOT_CONFIRMED", `a failed send is recorded as failed with the real error, not silently dropped from the ledger (got ${JSON.stringify(failEntry)})`);

  // duplicate detection: the exact same (target, text) sent twice in quick succession is flagged
  await resetAllParticipants();
  await call("send:compose", { text: "Repeat me exactly", targets: ["claude"] });
  await call("send:compose", { text: "Repeat me exactly", targets: ["claude"] });
  s = await call("state:get", {});
  const repeats = s.ledger.filter((e) => e.target === "claude" && e.textPreview === "Repeat me exactly");
  assert(repeats.length === 2 && repeats[0].duplicate === false && repeats[1].duplicate === true, `the first of two identical sends isn't flagged, the second (within the duplicate window) is (got flags [${repeats.map((e) => e.duplicate).join(", ")}])`);
}

async function testPersistenceSavesToDisk() {
  console.log("\n== Persistence: role/state changes get written to disk (debounced) ==");
  await resetAllParticipants();
  await call("roles:set", { site: "gemini", role: "Fact-checker" });
  await settle(250); // let the debounced save flush
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  const saved = JSON.parse(raw);
  assert(saved.customRole && saved.customRole.gemini === "Fact-checker", "the file on disk reflects the new role");
  await call("roles:set", { site: "gemini", role: "" }); // leave roles clean for later tests
  await settle(250);
}

async function testPromptLibrary() {
  console.log("\n== Prompt Library: built-in test prompt, save/send-different-text-per-AI/delete, persisted ==");
  await resetAllParticipants();

  const state0 = await call("state:get", {});
  const builtin = state0.prompts.find((p) => p.name === "System Test");
  assert(!!builtin, "the built-in 'System Test' prompt exists by default");
  assert(builtin.text.chatgpt.includes("Claude and Gemini"), "chatgpt's version of the built-in prompt names the other two AIs (Claude and Gemini)");
  assert(builtin.text.claude.includes("ChatGPT and Gemini"), "claude's version names the other two (ChatGPT and Gemini)");
  assert(builtin.text.gemini.includes("ChatGPT and Claude"), "gemini's version names the other two (ChatGPT and Claude)");

  const saveRes = await call("prompts:save", { id: null, name: "Custom Kickoff", text: { chatgpt: "Hello ChatGPT only", claude: "", gemini: "Hello Gemini only" } });
  assert(saveRes.ok, "saving a new prompt succeeds");
  const created = saveRes.prompts.find((p) => p.name === "Custom Kickoff");
  assert(!!created, "the new prompt comes back in the returned list");
  assert(created.text.claude === "", "an intentionally blank field stays blank rather than getting defaulted to something");

  const before = { chatgpt: sentLog("chatgpt").length, claude: sentLog("claude").length, gemini: sentLog("gemini").length };
  const sendRes = await call("prompts:send", { text: created.text });
  assert(sendRes.ok, "prompts:send succeeds when at least one field has text");
  await waitUntil(() => sentLog("chatgpt").length > before.chatgpt && sentLog("gemini").length > before.gemini, { label: "chatgpt and gemini both receive their own send" });
  assert(sentLog("claude").length === before.claude, "claude (the blank field) receives nothing at all");
  assert(sentLog("chatgpt")[sentLog("chatgpt").length - 1].text === "Hello ChatGPT only", "chatgpt gets its own exact text verbatim, no wrapper (this isn't a forward)");
  assert(sentLog("gemini")[sentLog("gemini").length - 1].text === "Hello Gemini only", "gemini gets its own distinct text in that same send");

  const emptyRes = await call("prompts:send", { text: { chatgpt: "", claude: "   ", gemini: "" } });
  assert(!emptyRes.ok && emptyRes.error === "NEED_TEXT", "sending with every field blank (or whitespace-only) is rejected, not a silent no-op");

  const editRes = await call("prompts:save", { id: created.id, name: "Custom Kickoff (edited)", text: { chatgpt: "v2", claude: "", gemini: "" } });
  assert(editRes.prompts.filter((p) => p.id === created.id).length === 1, "saving again with the same id updates it in place, doesn't duplicate");
  assert(editRes.prompts.find((p) => p.id === created.id).name === "Custom Kickoff (edited)", "the name is updated by the edit");

  const delRes = await call("prompts:delete", created.id);
  assert(delRes.ok && !delRes.prompts.some((p) => p.id === created.id), "deleting removes it from the list");

  await settle(250); // let the debounced save flush
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  const saved = JSON.parse(raw);
  assert(Array.isArray(saved.prompts) && !saved.prompts.some((p) => p.id === created.id), "the deletion is reflected in the persisted state file too");

  const explainer = state0.prompts.find((p) => p.name === "System Prompt (How Routing Works)");
  assert(!!explainer, "a second built-in prompt explaining [TO: X] tag routing also exists by default");
  assert(explainer.text.chatgpt.includes("[TO:") && explainer.text.claude.includes("[TO:") && explainer.text.gemini.includes("[TO:"), "every AI's version actually mentions the [TO: X] tag syntax");
  assert(explainer.text.chatgpt.includes("[FROM: CHATGPT]") && explainer.text.claude.includes("[FROM: CLAUDE]") && explainer.text.gemini.includes("[FROM: GEMINI]"),
    "each AI's explainer also teaches its own [FROM: X] closing tag (the end-tag completion signal)");
}

async function testPromptEditorWindow() {
  console.log("\n== Prompt Library's popup editor window: opens targeting the right prompt, closes on request, and saving there broadcasts to other windows ==");
  await resetAllParticipants();

  const openRes = await call("prompts:open-editor", 1);
  assert(openRes.ok, "opening the editor for an existing prompt (id 1) succeeds");
  const editorWin = mockElectron.__windowRegistry["AutoInjector — Edit Prompt"];
  assert(!!editorWin, "a real, separate window was created for it");
  assert(!editorWin.isDestroyed(), "it's open, not already closed");
  const editorView = reg("prompt-editor-ui");
  assert(!!editorView && editorView.webContents._loadOpts && editorView.webContents._loadOpts.search === "id=1", "it navigates with the target prompt's id in the URL, so the popup's own page knows which one to load");

  const openNewRes = await call("prompts:open-editor", null);
  assert(openNewRes.ok, "requesting a blank/new prompt while the editor is already open re-targets it rather than opening a second window");
  assert(reg("prompt-editor-ui").webContents._loadOpts.search === "", "re-navigates with no id — a blank prompt this time");
  assert(mockElectron.__windowRegistry["AutoInjector — Edit Prompt"] === editorWin, "still the same single window instance, not a second one");

  let broadcastPrompts = null;
  const onSend = (channel, payload) => { if (channel === "prompts-changed") broadcastPrompts = payload; };
  reg("controls-ui").webContents.on("ipc-send", onSend);
  const saveRes = await call("prompts:save", { id: null, name: "From The Popup", text: { chatgpt: "hi", claude: "", gemini: "" } });
  assert(saveRes.ok, "saving from what would be the popup's Save button works the same as any other save");
  assert(!!broadcastPrompts && broadcastPrompts.some((p) => p.name === "From The Popup"), "the Automation window gets a 'prompts-changed' broadcast so its dropdown updates without a manual refresh");
  reg("controls-ui").webContents.off("ipc-send", onSend);
  await call("prompts:delete", saveRes.prompts.find((p) => p.name === "From The Popup").id); // leave state clean for later tests

  const closeRes = await call("prompt-editor:close", {});
  assert(closeRes.ok, "closing the editor succeeds");
  assert(editorWin.isDestroyed(), "the window is actually closed");
}

function makeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoinjector-doc-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function resetDebuggerFlags() {
  for (const s of SITES) {
    const wc = reg(s).webContents;
    wc.fileInputSets = [];
    wc._fileInputExists = true;
    wc._forceAttachFail = false;
    wc._forceSetFilesFail = false;
  }
}

async function testDocumentSendHappyPath() {
  console.log("\n== document:send — happy path delivers the file to exactly the checked targets ==");
  resetDebuggerFlags();
  const file = makeTempFile("plan.txt", "hello");

  const res = await call("document:send", { path: file, targets: ["chatgpt", "claude"] });
  assert(res.ok, "document:send succeeds");
  assert(res.results.chatgpt.ok && res.results.claude.ok, "both checked targets report ok");
  assert(reg("chatgpt").webContents.fileInputSets.length === 1 && reg("chatgpt").webContents.fileInputSets[0].files[0] === file, "chatgpt actually received a DOM.setFileInputFiles call with this exact path");
  assert(reg("claude").webContents.fileInputSets.length === 1, "claude too");
  assert(reg("gemini").webContents.fileInputSets.length === 0, "gemini, never targeted, got nothing at all");
}

async function testDocumentSendNoFileInputFound() {
  console.log("\n== document:send — a site with no matching file input fails cleanly, doesn't block the others ==");
  resetDebuggerFlags();
  const file = makeTempFile("plan.txt", "hello");
  reg("claude").webContents._fileInputExists = false;

  const res = await call("document:send", { path: file, targets: ["chatgpt", "claude"] });
  assert(res.ok, "document:send still reports ok overall — per-target failures don't fail the whole call");
  assert(res.results.chatgpt.ok, "chatgpt (unaffected) still succeeds");
  assert(!res.results.claude.ok && res.results.claude.error === "NO_FILE_INPUT_FOUND", "claude reports NO_FILE_INPUT_FOUND specifically, not a generic failure");
}

async function testDocumentSendSetFilesFails() {
  console.log("\n== document:send — DOM.setFileInputFiles failing is reported distinctly, and the debugger still detaches ==");
  resetDebuggerFlags();
  const file = makeTempFile("plan.txt", "hello");
  reg("gemini").webContents._forceSetFilesFail = true;

  const res = await call("document:send", { path: file, targets: ["gemini"] });
  assert(!res.results.gemini.ok && res.results.gemini.error === "SET_FILES_FAILED", "reports SET_FILES_FAILED specifically");
  assert(reg("gemini").webContents._debuggerAttached === false, "the debugger was detached even on this failure path (proves the finally{} runs)");
}

async function testDocumentSendAttachFails() {
  console.log("\n== document:send — debugger.attach() failing (e.g. DevTools already attached) is reported distinctly ==");
  resetDebuggerFlags();
  const file = makeTempFile("plan.txt", "hello");
  reg("chatgpt").webContents._forceAttachFail = true;

  const res = await call("document:send", { path: file, targets: ["chatgpt"] });
  assert(!res.results.chatgpt.ok && res.results.chatgpt.error === "ATTACH_FAILED", "reports ATTACH_FAILED specifically");
}

async function testDocumentSendFileNotFoundOrNoTargets() {
  console.log("\n== document:send — a missing file or an empty target list are rejected before any per-target work ==");
  resetDebuggerFlags();
  const missingRes = await call("document:send", { path: "/no/such/file/anywhere.txt", targets: ["chatgpt"] });
  assert(!missingRes.ok && missingRes.error === "FILE_NOT_FOUND", "a nonexistent path is rejected up front");
  assert(reg("chatgpt").webContents.fileInputSets.length === 0, "...and never even attempted against chatgpt");

  const file = makeTempFile("plan.txt", "hello");
  const noTargetsRes = await call("document:send", { path: file, targets: [] });
  assert(!noTargetsRes.ok && noTargetsRes.error === "NO_TARGETS", "an empty target list is rejected too");
}

async function testDocumentRead() {
  console.log("\n== document:read — classifies files by extension and respects the text size cap ==");
  const smallText = makeTempFile("note.txt", "short note");
  const textRes = await call("document:read", smallText);
  assert(textRes.ok && textRes.kind === "text" && textRes.tooLarge === false && textRes.text === "short note", "small text file reads its actual content");

  const bigText = makeTempFile("big.txt", "x".repeat(600 * 1024));
  const bigRes = await call("document:read", bigText);
  assert(bigRes.ok && bigRes.kind === "text" && bigRes.tooLarge === true && bigRes.text === "", "an oversized text file is flagged tooLarge instead of reading it all into memory");

  const image = makeTempFile("shot.png", "not a real png but extension is what matters here");
  const imageRes = await call("document:read", image);
  assert(imageRes.ok && imageRes.kind === "image" && imageRes.fileUrl && imageRes.fileUrl.startsWith("file://"), "image files get a file:// URL for direct Chromium rendering, not bytes shuttled through IPC");

  const pdf = makeTempFile("doc.pdf", "%PDF-1.4 fake");
  const pdfRes = await call("document:read", pdf);
  assert(pdfRes.ok && pdfRes.kind === "pdf" && pdfRes.fileUrl && pdfRes.fileUrl.startsWith("file://"), "pdf files also get a file:// URL, same as images");

  const other = makeTempFile("archive.zip", "PK\x03\x04");
  const otherRes = await call("document:read", other);
  assert(otherRes.ok && otherRes.kind === "other", "an unrecognized extension still reports ok with kind:'other' (filename-only, no preview)");

  const missingRes = await call("document:read", "/no/such/file.txt");
  assert(!missingRes.ok && missingRes.error === "FILE_NOT_FOUND", "reading a nonexistent path fails cleanly");
}

async function testDocumentChooseAndViewerWindow() {
  console.log("\n== document:choose — opens the file dialog, then the document viewer window targeting the chosen file ==");
  mockElectron.__setDialogResult({ canceled: true, filePaths: [] });
  const cancelledRes = await call("document:choose", {});
  assert(!cancelledRes.ok && cancelledRes.error === "CANCELLED", "a cancelled dialog is reported as CANCELLED, not an error");
  assert(!mockElectron.__windowRegistry["AutoInjector — Document"], "cancelling never opens a viewer window");

  const file = makeTempFile("report.txt", "hi");
  mockElectron.__setDialogResult({ canceled: false, filePaths: [file] });
  const chooseRes = await call("document:choose", {});
  assert(chooseRes.ok && chooseRes.path === file, "choosing a file returns its path");
  const viewerWin = mockElectron.__windowRegistry["AutoInjector — Document"];
  assert(!!viewerWin && !viewerWin.isDestroyed(), "a real, separate window opens for it");
  const viewerView = reg("document-viewer-ui");
  assert(!!viewerView && viewerView.webContents._loadOpts.search === `path=${encodeURIComponent(file)}`, "it navigates with the chosen file's path in the URL");

  const file2 = makeTempFile("report2.txt", "hi again");
  mockElectron.__setDialogResult({ canceled: false, filePaths: [file2] });
  await call("document:choose", {});
  assert(mockElectron.__windowRegistry["AutoInjector — Document"] === viewerWin, "choosing a second file while the viewer is open re-targets the SAME window, not a second one");
  assert(reg("document-viewer-ui").webContents._loadOpts.search === `path=${encodeURIComponent(file2)}`, "...re-navigated to the new file");

  const closeRes = await call("document-viewer:close", {});
  assert(closeRes.ok, "closing the viewer succeeds");
  assert(viewerWin.isDestroyed(), "the window is actually closed");
}

async function testSequenceWindowManagement() {
  console.log("\n== sequence:open / sequence-editor:close manage a single popup window ==");
  const openRes = await call("sequence:open", {});
  assert(openRes.ok, "opens successfully");
  const seqWin = mockElectron.__windowRegistry["AutoInjector — Prompt Sequence"];
  assert(!!seqWin && !seqWin.isDestroyed(), "a real window opens for it");

  await call("sequence:open", {});
  assert(mockElectron.__windowRegistry["AutoInjector — Prompt Sequence"] === seqWin, "opening again re-focuses the SAME window, not a second one");

  const closeRes = await call("sequence-editor:close", {});
  assert(closeRes.ok, "closing succeeds");
  assert(seqWin.isDestroyed(), "the window is actually closed");
}

async function testSequenceBackend() {
  console.log("\n== Prompt Sequence: steps fire one at a time, each waiting for that step's target to actually reply ==");
  await resetAllParticipants();
  await call("sequence:stop", {}); // defensive, mirrors resetAllParticipants()'s own houserule:stop

  const steps = [
    { target: "chatgpt", text: "Step 1 for chatgpt" },
    { target: "all", text: "Step 2 for everyone" },
    { target: "claude", text: "Step 3 for claude" }
  ];
  const runRes = await call("sequence:run", { steps });
  assert(runRes.ok, "sequence starts successfully");

  await waitUntil(() => sentLog("chatgpt").some((e) => e.text === "Step 1 for chatgpt"), { label: "step 1 sent to chatgpt only" });
  assert(sentLog("claude").length === 0 && sentLog("gemini").length === 0, "nobody else gets anything yet -- waiting on chatgpt's reply");
  let s = await call("state:get", {});
  assert(s.sequence.active === true && s.sequence.index === 0, "sequence state reports step 0 active");

  // a reply from a site the current step didn't address must NOT advance it
  say("claude", "I wasn't asked anything, ignore me.");
  await settle();
  s = await call("state:get", {});
  assert(s.sequence.index === 0, "an unaddressed site's reply does not advance the sequence");

  say("chatgpt", "Here's my reply to step 1.");
  await waitUntil(() => SITES.every((s2) => sentLog(s2).some((e) => e.text === "Step 2 for everyone")), { label: "step 2 ('all') sent to all three once chatgpt's reply advances the sequence" });
  s = await call("state:get", {});
  assert(s.sequence.index === 1, "advanced to step 1 (the 'all' step)");

  // for an 'all' step, the FIRST of the three to reply is enough to advance
  say("gemini", "Gemini replies first.");
  await waitUntil(() => sentLog("claude").some((e) => e.text === "Step 3 for claude"), { label: "step 3 sent to claude once the first reply to the 'all' step lands" });
  s = await call("state:get", {});
  assert(s.sequence.index === 2, "advanced to step 2 off the first of the three replies, without waiting for the other two");

  say("claude", "Final reply.");
  await waitUntil(async () => !(await call("state:get", {})).sequence.active, { label: "sequence finishes after the last step's reply" });
  s = await call("state:get", {});
  assert(s.sequence.active === false, "sequence reports inactive once every step is done");
}

async function testSequenceRejectsWhileRunningAndInvalidSteps() {
  console.log("\n== Prompt Sequence: rejects starting a second run while one is active, and filters malformed steps ==");
  await resetAllParticipants();
  await call("sequence:stop", {});

  const res1 = await call("sequence:run", { steps: [{ target: "chatgpt", text: "Go" }] });
  assert(res1.ok, "first run starts");
  const res2 = await call("sequence:run", { steps: [{ target: "claude", text: "Also go" }] });
  assert(!res2.ok && res2.error === "ALREADY_RUNNING", "a second run while one is active is rejected");

  const stopRes = await call("sequence:stop", {});
  assert(stopRes.ok, "sequence:stop succeeds");
  const s = await call("state:get", {});
  assert(s.sequence.active === false, "stopping mid-run marks it inactive");

  const badRes = await call("sequence:run", { steps: [{ target: "not-a-site", text: "bad target" }, { target: "chatgpt", text: "   " }] });
  assert(!badRes.ok && badRes.error === "NO_VALID_STEPS", "steps with a bad target or blank-after-trim text are filtered out, and an empty result after filtering is rejected");

  await call("sequence:stop", {});
}

async function testZoomIPC() {
  console.log("\n== site:zoom clamps the factor and calls setZoomFactor on the real embedded page ==");
  const res = await call("site:zoom", { site: "gemini", factor: 1.5 });
  assert(res.ok && res.factor === 1.5, "an in-range factor passes through unchanged");
  assert(reg("gemini").webContents.zoomFactor === 1.5, "setZoomFactor was actually called with it");

  const tooHigh = await call("site:zoom", { site: "gemini", factor: 5 });
  assert(tooHigh.ok && tooHigh.factor === 2, "an out-of-range high factor is clamped to the max (2)");

  const tooLow = await call("site:zoom", { site: "gemini", factor: 0.01 });
  assert(tooLow.ok && tooLow.factor === 0.4, "an out-of-range low factor is clamped to the min (0.4)");

  reg("gemini").webContents.setZoomFactor(1); // restore, so this doesn't leak into later scenarios
}

function extractCFG(script) {
  const marker = "const CFG = ";
  const start = script.indexOf(marker);
  const jsonStart = start + marker.length;
  const end = script.indexOf(";\n", jsonStart);
  return JSON.parse(script.slice(jsonStart, end));
}

function testSelectorOverridePriorityInScripts() {
  console.log("\n== automation.js: a picked override is tried BEFORE the built-in candidates, not instead of them ==");

  const sendWithOverride = extractCFG(automation.buildSendScript("claude", "hi", { input: "#my-input", send: "#my-send" }));
  assert(sendWithOverride.INPUT_CANDIDATES[0] === "#my-input" && sendWithOverride.INPUT_CANDIDATES.length > 1, "input override is tried first, built-ins still follow as fallback");
  assert(sendWithOverride.SEND_CANDIDATES[0] === "#my-send" && sendWithOverride.SEND_CANDIDATES.length > 1, "send override is tried first, built-ins still follow as fallback");

  const sendNoOverride = extractCFG(automation.buildSendScript("claude", "hi", {}));
  assert(sendNoOverride.INPUT_CANDIDATES[0] !== "#my-input", "with no override, the built-in candidate list is used unmodified");
  const sendUndefinedOverride = extractCFG(automation.buildSendScript("claude", "hi"));
  assert(sendUndefinedOverride.INPUT_CANDIDATES[0] !== "#my-input", "overrides argument is optional -- omitting it entirely doesn't throw");

  const readWithOverride = extractCFG(automation.buildReadScript("gemini", { assistant: ".my-reply" }));
  assert(readWithOverride.ASSISTANT_CANDIDATES[0] === ".my-reply" && readWithOverride.ASSISTANT_CANDIDATES.length > 1, "assistant override is tried first for reading too, with built-ins as fallback");
  const readNoOverride = extractCFG(automation.buildReadScript("gemini", {}));
  assert(readNoOverride.ASSISTANT_CANDIDATES[0] !== ".my-reply", "with no override, reading uses the built-in candidate list unmodified");

  const pickScript = automation.buildPickScript("input");
  assert(pickScript.includes("__AUTOINJECTOR_PICK__"), "the pick script carries the marker the test mock (and nothing else) keys off of");
  assert(pickScript.includes('const ROLE = "input"'), "the requested role is embedded in the script");
}

async function testSelectorPicker() {
  console.log("\n== Selector picker: click-to-pick overrides are captured, take priority, persist, and can be cleared ==");
  await resetAllParticipants();

  let s = await call("state:get", {});
  assert(JSON.stringify(s.global.selectorOverrides.claude) === "{}", "starts with no overrides for claude");

  reg("claude").webContents._nextPickResult = { ok: true, selector: '[data-testid="composer-input"]', tag: "div", sample: "" };
  const pickRes = await call("selector:pick", { site: "claude", role: "input" });
  assert(pickRes.ok && pickRes.selector === '[data-testid="composer-input"]', "a successful pick returns the captured selector");
  assert(reg("claude").webContents.pickCalls.length === 1 && reg("claude").webContents.pickCalls[0].role === "input", "the injected script actually requested the 'input' role");

  s = await call("state:get", {});
  assert(s.global.selectorOverrides.claude.input === '[data-testid="composer-input"]', "the override is stored and visible via state:get");
  assert(s.log.some((l) => l.kind === "selector-pick-started" && l.detail.site === "claude" && l.detail.role === "input"), "the Activity Log records that a pick started, not just its eventual result");
  assert(s.log.some((l) => l.kind === "selector-picked" && l.detail.selector === '[data-testid="composer-input"]' && l.detail.tag === "div"), "the Activity Log records the picked selector and tag on success");

  await settle(250); // let the debounced save flush
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  const saved = JSON.parse(raw);
  assert(saved.selectorOverrides && saved.selectorOverrides.claude && saved.selectorOverrides.claude.input === '[data-testid="composer-input"]', "the override survives to the persisted state file");

  reg("gemini").webContents._nextPickResult = { ok: true, selector: "div.reply-body", tag: "div", sample: "Hello there" };
  const pickRes2 = await call("selector:pick", { site: "gemini", role: "assistant" });
  assert(pickRes2.ok && pickRes2.sample === "Hello there", "a different site/role picks independently and returns its own sample text");
  s = await call("state:get", {});
  assert(!s.global.selectorOverrides.claude.assistant, "claude's assistant role is untouched by gemini's pick");
  assert(s.global.selectorOverrides.gemini.assistant === "div.reply-body", "gemini's assistant override is stored separately");
  assert(s.log.some((l) => l.kind === "selector-picked" && l.detail.site === "gemini" && l.detail.sample === "Hello there"), "the Activity Log also records the sample text that was actually captured, so you can tell a good pick from a bad one just by reading the log");

  reg("chatgpt").webContents._nextPickResult = { ok: false, error: "TIMEOUT" };
  const timeoutRes = await call("selector:pick", { site: "chatgpt", role: "send" });
  assert(!timeoutRes.ok && timeoutRes.error === "TIMEOUT", "a pick that times out (no click) is reported, not silently ignored");
  s = await call("state:get", {});
  assert(JSON.stringify(s.global.selectorOverrides.chatgpt) === "{}", "a failed pick never stores an override");
  assert(s.log.some((l) => l.kind === "selector-pick-error" && l.detail.site === "chatgpt" && l.detail.role === "send" && l.detail.error === "TIMEOUT"), "a failed pick is logged with its specific reason too, not silently dropped");

  const badSite = await call("selector:pick", { site: "not-a-site", role: "input" });
  assert(!badSite.ok && badSite.error === "BAD_SITE", "an unknown site is rejected");
  const badRole = await call("selector:pick", { site: "claude", role: "not-a-role" });
  assert(!badRole.ok && badRole.error === "BAD_ROLE", "an unknown role is rejected");

  const clearRes = await call("selector:clear", { site: "claude", role: "input" });
  assert(clearRes.ok, "clearing succeeds");
  s = await call("state:get", {});
  assert(!s.global.selectorOverrides.claude.input, "the override is gone after clearing");

  await call("selector:clear", { site: "gemini", role: "assistant" }); // leave state clean for later scenarios
}

async function testSelectorPickerValidation() {
  console.log("\n== Selector picker: a click alone isn't enough -- the pick is validated against the live page before it's ever saved ==");
  await resetAllParticipants();

  reg("claude").webContents._nextPickResult = { ok: true, selector: ".stale-selector", tag: "div", sample: "", matchCount: 0, visible: true, roleOk: true };
  let res = await call("selector:pick", { site: "claude", role: "input" });
  assert(!res.ok && res.error === "NOT_FOUND", "a selector that doesn't actually resolve back to any element (matchCount 0) is rejected, not saved");
  let s = await call("state:get", {});
  assert(!s.global.selectorOverrides.claude.input, "the rejected pick never becomes an override");
  assert(s.log.some((l) => l.kind === "selector-pick-rejected" && l.detail.site === "claude" && l.detail.reasons.includes("NOT_FOUND")), "the Activity Log records why it was rejected");

  reg("claude").webContents._nextPickResult = { ok: true, selector: ".hidden-el", tag: "textarea", sample: "", matchCount: 1, visible: false, roleOk: true };
  res = await call("selector:pick", { site: "claude", role: "input" });
  assert(!res.ok && res.error === "NOT_VISIBLE", "a matched but zero-size/hidden element is rejected");

  reg("claude").webContents._nextPickResult = { ok: true, selector: ".wrong-kind", tag: "span", sample: "", matchCount: 1, visible: true, roleOk: false };
  res = await call("selector:pick", { site: "claude", role: "send" });
  assert(!res.ok && res.error === "WRONG_ELEMENT_TYPE", "an element of the wrong kind for the role (e.g. not a button for 'send') is rejected");

  // echo detection: the "assistant" pick just reads back the last thing WE sent
  await call("send:compose", { text: "What's the capital of France?", targets: ["claude"] });
  reg("claude").webContents._nextPickResult = { ok: true, selector: ".composer-echo", tag: "div", sample: "What's the capital of France?", matchCount: 1, visible: true, roleOk: true };
  res = await call("selector:pick", { site: "claude", role: "assistant" });
  assert(!res.ok && res.error === "LOOKS_LIKE_ECHO", "an 'assistant' pick whose sample just echoes the last message WE sent is rejected, not saved as if it read a real reply");
  s = await call("state:get", {});
  assert(!s.global.selectorOverrides.claude.assistant, "the echo pick never becomes an override");

  // a fully valid pick (all fields present and passing) still saves normally
  reg("claude").webContents._nextPickResult = { ok: true, selector: '[data-testid="reply"]', tag: "div", sample: "Paris is the capital of France.", matchCount: 1, visible: true, roleOk: true };
  res = await call("selector:pick", { site: "claude", role: "assistant" });
  assert(res.ok && res.selector === '[data-testid="reply"]', "a pick that passes every check still saves normally");
  s = await call("state:get", {});
  assert(s.global.selectorOverrides.claude.assistant === '[data-testid="reply"]', "the valid override is actually stored");

  await call("selector:clear", { site: "claude", role: "assistant" });
}

async function testSavedLogins() {
  console.log("\n== Saved logins: encrypted at rest, decrypted only for an explicit fill, never sent to the renderer or logged in plaintext ==");
  await resetAllParticipants();
  mockElectron.__setEncryptionAvailable(true);

  const before = await call("logins:list", {});
  assert(before.ok && before.logins.claude.length === 0, "starts with no saved logins for claude");

  const saveRes = await call("logins:save", { site: "claude", label: "Personal", username: "me@example.com", password: "hunter2" });
  assert(saveRes.ok, "saving a login succeeds");
  assert(saveRes.logins.length === 1 && saveRes.logins[0].label === "Personal" && saveRes.logins[0].username === "me@example.com", "the response includes the new entry's label/username");
  assert(saveRes.logins[0].password === undefined && saveRes.logins[0].encryptedPassword === undefined, "the password (encrypted or not) is NEVER sent back to the renderer, not even the ciphertext");

  const listed = await call("logins:list", {});
  assert(listed.logins.claude.length === 1 && listed.logins.claude[0].username === "me@example.com", "logins:list reflects the save");
  const loginId = listed.logins.claude[0].id;

  // persisted to disk -- but only as ciphertext, never the raw password
  await settle(250);
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  assert(!raw.includes("hunter2"), "the raw password never appears anywhere in the persisted state file");
  const savedOnDisk = JSON.parse(raw);
  assert(savedOnDisk.savedLogins.claude[0].encryptedPassword && savedOnDisk.savedLogins.claude[0].encryptedPassword !== "hunter2", "what IS persisted is the encrypted ciphertext, keyed under encryptedPassword, distinct from the raw password");

  // the fill actually decrypts back to the real password and reaches the DOM script
  const fillRes = await call("logins:fill", { site: "claude", id: loginId });
  assert(fillRes.ok && fillRes.submitted === true, "filling a saved login succeeds and reports it submitted");
  const fillCall = reg("claude").webContents.loginFillCalls[reg("claude").webContents.loginFillCalls.length - 1];
  assert(fillCall.username === "me@example.com" && fillCall.password === "hunter2", "the DOM script actually received the real, correctly-decrypted username and password");

  const s = await call("state:get", {});
  assert(!s.log.some((l) => JSON.stringify(l.detail).includes("hunter2")), "the raw password never appears in the Activity Log either, including around the fill action");
  assert(s.log.some((l) => l.kind === "login-saved" && l.detail.site === "claude" && l.detail.username === "me@example.com" && l.detail.password === undefined), "a save is logged with the label/username but never the password");
  assert(s.log.some((l) => l.kind === "login-fill-started" && l.detail.label === "Personal") && s.log.some((l) => l.kind === "login-fill-ok"), "a fill is logged as starting and succeeding, by label, never by credential value");

  // multiple logins per site (e.g. "multiple different types of ChatGPT logins")
  const secondSave = await call("logins:save", { site: "claude", label: "Work", username: "work@example.com", password: "correcthorse" });
  assert(secondSave.ok && secondSave.logins.length === 2, "a second, independent login can be saved for the same site");

  const deleteRes = await call("logins:delete", { site: "claude", id: loginId });
  assert(deleteRes.ok && deleteRes.logins.length === 1 && deleteRes.logins[0].label === "Work", "deleting one login leaves the other untouched");
  const deleteMissing = await call("logins:delete", { site: "claude", id: loginId });
  assert(!deleteMissing.ok && deleteMissing.error === "NOT_FOUND", "deleting an already-gone id is rejected cleanly, not a silent no-op");

  // validation
  const badSite = await call("logins:save", { site: "not-a-site", label: "x", username: "x", password: "x" });
  assert(!badSite.ok && badSite.error === "BAD_SITE", "an unknown site is rejected");
  const noLabel = await call("logins:save", { site: "gemini", label: "", username: "x", password: "x" });
  assert(!noLabel.ok && noLabel.error === "NEEDS_LABEL", "a blank label is rejected");
  const noUser = await call("logins:save", { site: "gemini", label: "x", username: "", password: "x" });
  assert(!noUser.ok && noUser.error === "NEEDS_USERNAME", "a blank username is rejected");
  const noPass = await call("logins:save", { site: "gemini", label: "x", username: "x", password: "" });
  assert(!noPass.ok && noPass.error === "NEEDS_PASSWORD", "a blank password is rejected");

  const fillMissing = await call("logins:fill", { site: "gemini", id: 99999 });
  assert(!fillMissing.ok && fillMissing.error === "NOT_FOUND", "filling a nonexistent saved login is rejected cleanly");

  // no OS keychain backend available -- refuses to save rather than silently falling back to plaintext
  mockElectron.__setEncryptionAvailable(false);
  const noEncryption = await call("logins:save", { site: "gemini", label: "x", username: "x", password: "x" });
  assert(!noEncryption.ok && noEncryption.error === "ENCRYPTION_UNAVAILABLE", "refuses to save at all when secure storage isn't available, rather than falling back to storing plaintext");
  mockElectron.__setEncryptionAvailable(true);

  // the DOM script itself only fills whichever field(s) it actually finds --
  // a multi-step login (e.g. email-only screen) is a real, expected outcome
  reg("gemini").webContents._nextLoginFillResult = { ok: true, filled: ["username"], submitted: false, warning: "SUBMIT_NOT_FOUND" };
  const partialSave = await call("logins:save", { site: "gemini", label: "Multi-step", username: "a@b.com", password: "pw" });
  const partialFill = await call("logins:fill", { site: "gemini", id: partialSave.logins[0].id });
  assert(partialFill.ok && partialFill.filled.length === 1 && partialFill.submitted === false, "a multi-step login (only one field present) is reported honestly, not as a full success or a failure");

  // no login form present at all
  reg("gemini").webContents._nextLoginFillResult = { ok: false, error: "NO_LOGIN_FORM_FOUND" };
  const noFormFill = await call("logins:fill", { site: "gemini", id: partialSave.logins[0].id });
  assert(!noFormFill.ok && noFormFill.error === "NO_LOGIN_FORM_FOUND", "no login fields found on screen is reported distinctly, not confused with a real failure");
  reg("gemini").webContents._nextLoginFillResult = null;
}

function extractSelftestToken(sentText) {
  const m = sentText.match(/: (\S+)$/);
  return m ? m[1] : null;
}
function reverseStr(s) { return s.split("").reverse().join(""); }

async function testSelfTestConnectivity() {
  console.log("\n== Connectivity Test: sends a reverse-the-token challenge, waits for it to come back transformed, and reports each distinct outcome (pass/too-broad/echo/mismatch/send-failure) ==");
  await resetAllParticipants();

  // happy path -- the site actually reverses the token like it was asked to
  const okPromise = call("selftest:run", { site: "claude" });
  await waitUntil(() => sentLog("claude").length === 1, { label: "test prompt sent to claude" });
  const sentText = sentLog("claude")[0].text;
  assert(sentText.includes("Reverse the letters of this token"), "the test prompt asks for the token REVERSED, not echoed verbatim -- a selector that just reads the sent prompt back can't satisfy that");
  const token = extractSelftestToken(sentText);
  assert(!!token, "a token was actually embedded in the sent prompt");
  say("claude", reverseStr(token));
  const okRes = await okPromise;
  assert(okRes.ok === true, "a reply containing the reversed token (and not the original) is reported as a pass");
  let s = await call("state:get", {});
  assert(s.log.some((l) => l.kind === "selftest-started" && l.detail.site === "claude" && l.detail.token === token && l.detail.reversedToken === reverseStr(token)), "the Activity Log records the test starting, with both the original and reversed token");
  assert(s.log.some((l) => l.kind === "selftest-waiting-for-reply" && l.detail.site === "claude"), "the Activity Log shows it's specifically waiting on a reply now, not just silence");
  assert(s.log.some((l) => l.kind === "selftest-ok" && l.detail.site === "claude"), "the Activity Log records the pass");

  // too-broad -- a selector reading both the sent prompt (with the original
  // token) AND the real reply (with the reversed token) must NOT pass, since
  // that's exactly the false-positive a plain token-echo test couldn't catch
  await resetAllParticipants();
  const broadPromise = call("selftest:run", { site: "chatgpt" });
  await waitUntil(() => sentLog("chatgpt").length === 1, { label: "test prompt sent to chatgpt" });
  const broadToken = extractSelftestToken(sentLog("chatgpt")[0].text);
  say("chatgpt", `You said: ${broadToken}\nReversed: ${reverseStr(broadToken)}`);
  const broadRes = await broadPromise;
  assert(!broadRes.ok && broadRes.error === "SELECTOR_TOO_BROAD", "a capture containing BOTH the original and reversed token is reported as SELECTOR_TOO_BROAD, not a pass");
  s = await call("state:get", {});
  assert(s.log.some((l) => l.kind === "selftest-error" && l.detail.site === "chatgpt" && l.detail.error === "SELECTOR_TOO_BROAD"), "the Activity Log records the too-broad verdict");

  // echo -- only the ORIGINAL token comes back (selector reading the
  // outgoing prompt, not any real reply) -- must be distinguished from a pass
  await resetAllParticipants();
  const echoPromise = call("selftest:run", { site: "gemini" });
  await waitUntil(() => sentLog("gemini").length === 1, { label: "test prompt sent to gemini" });
  const echoToken = extractSelftestToken(sentLog("gemini")[0].text);
  say("gemini", `Reverse the letters of this token and reply with ONLY the reversed result: ${echoToken}`);
  const echoRes = await echoPromise;
  assert(!echoRes.ok && echoRes.error === "REPLY_ECHO", "a capture containing only the ORIGINAL token (never the reversed form) is reported as REPLY_ECHO, not a pass");

  // mismatch -- a reply DOES come back, but matches neither form
  await resetAllParticipants();
  const mismatchPromise = call("selftest:run", { site: "gemini" });
  await waitUntil(() => sentLog("gemini").length === 1, { label: "test prompt sent to gemini" });
  sayRaw("gemini", "Sure, here's an unrelated reply that doesn't contain any token."); // self-test reads the pane raw; no envelope
  const mismatchRes = await mismatchPromise;
  assert(!mismatchRes.ok && mismatchRes.error === "REPLY_MISMATCH", "a reply that arrives but matches neither the original nor reversed token is reported as REPLY_MISMATCH, not a pass");
  assert(mismatchRes.text === "Sure, here's an unrelated reply that doesn't contain any token.", "the mismatch result carries back exactly what WAS captured, so a broken read-selector can actually be diagnosed");
  s = await call("state:get", {});
  assert(s.log.some((l) => l.kind === "selftest-error" && l.detail.site === "gemini" && l.detail.error === "REPLY_MISMATCH" && l.detail.capturedText.includes("unrelated reply")), "the Activity Log records the mismatch AND what was actually captured instead");

  // a send that never actually goes through is reported at the send stage, without waiting on any reply at all
  await resetAllParticipants();
  reg("chatgpt").webContents._forceSendFail = true;
  const sendFailRes = await call("selftest:run", { site: "chatgpt" });
  assert(!sendFailRes.ok && sendFailRes.stage === "send" && sendFailRes.error === "SEND_NOT_CONFIRMED", "a send that never actually submits is reported at the send stage, not misread as a missing reply");
  reg("chatgpt").webContents._forceSendFail = false;
  s = await call("state:get", {});
  assert(s.log.some((l) => l.kind === "selftest-send-error" && l.detail.site === "chatgpt" && l.detail.error === "SEND_NOT_CONFIRMED"), "a send-stage failure is logged distinctly from a reply-stage failure");

  // validation
  const badSite = await call("selftest:run", { site: "not-a-site" });
  assert(!badSite.ok && badSite.error === "BAD_SITE", "an unknown site is rejected");

  // running a second test for the same site while one's already in flight is rejected, not queued or crossed
  await resetAllParticipants();
  const firstRunPromise = call("selftest:run", { site: "claude" });
  await waitUntil(() => sentLog("claude").length === 1, { label: "first test's prompt sent" });
  const secondRun = await call("selftest:run", { site: "claude" });
  assert(!secondRun.ok && secondRun.error === "ALREADY_RUNNING", "a second test for the same site while one is already running is rejected");
  const firstToken = extractSelftestToken(sentLog("claude")[0].text);
  say("claude", reverseStr(firstToken));
  const firstRunRes = await firstRunPromise;
  assert(firstRunRes.ok === true, "the original in-flight test still resolves normally afterward");
}

async function testTunerFullRun() {
  console.log("\n== The Tuner: runs the per-site connectivity check on all 3 sites, then a genuine A-to-B relay check on all 6 directed pairs ==");
  await resetAllParticipants();

  const tunerRunPromise = call("tuner:run", {});

  // Phase 1: one connectivity check per site, same mechanism as the 🧪 Test button
  for (const site of SITES) {
    await waitUntil(() => sentLog(site).length >= 1, { label: `tuner's connectivity check sent to ${site}` });
    const token = extractSelftestToken(sentLog(site)[sentLog(site).length - 1].text);
    say(site, reverseStr(token));
  }

  // Phase 2: all 6 directed relay legs -- source answers directly, then
  // (once mesh has forwarded it) target answers too, exactly like a real
  // pair of AIs would.
  const legs = [];
  for (const source of SITES) for (const target of SITES) if (source !== target) legs.push([source, target]);

  for (const [source, target] of legs) {
    const beforeSource = sentLog(source).length;
    const beforeTarget = sentLog(target).length;
    await waitUntil(() => sentLog(source).length > beforeSource, { label: `tuner's relay prompt sent directly to ${source} (leg ${source}->${target})` });
    const sourceSentText = sentLog(source)[sentLog(source).length - 1].text;
    assert(sourceSentText.includes("RELAY-TEST") && sourceSentText.includes("forwarded to you by another AI"), `the relay prompt asks for the self-selecting conditional reply, not a literal "relay this" instruction (leg ${source}->${target})`);
    const relayToken = sourceSentText.match(/RELAY-TEST (\S+)/)[1];
    say(source, `RELAY-TEST ${relayToken}`);

    await waitUntil(() => sentLog(target).length > beforeTarget, { label: `mesh forwards ${source}'s reply on to ${target} (leg ${source}->${target})` });
    assert(sentLog(target)[sentLog(target).length - 1].text.includes(`RELAY-TEST ${relayToken}`), `${target} receives the forwarded reply verbatim, instruction included (leg ${source}->${target})`);
    say(target, `RELAY-RECEIVED ${relayToken}`);
  }

  const res = await tunerRunPromise;
  assert(res.ok, "the full tuner run resolves ok");
  assert(res.summary.sitesOk === 3 && res.summary.sitesTotal === 3, `all 3 site checks passed (got ${res.summary.sitesOk}/${res.summary.sitesTotal})`);
  assert(res.summary.legsOk === 6 && res.summary.legsTotal === 6, `all 6 relay legs passed (got ${res.summary.legsOk}/${res.summary.legsTotal})`);
  assert(Object.keys(res.legs).length === 6, "exactly 6 legs were tested, one per directed pair");
  assert(SITES.every((site) => res.sites[site].ok), "every individual site result is itself a pass, not just the summary count");

  const s = await call("state:get", {});
  assert(SITES.every((site) => s.global.routing[site].length === 0), "the tuner cleans up after itself -- no mesh routing left on for any site once it's done, since none was configured beforehand");
  assert(s.log.some((l) => l.kind === "tuner-started") && s.log.some((l) => l.kind === "tuner-done" && l.detail.sitesOk === 3 && l.detail.legsOk === 6), "the Activity Log records the run starting and its final tally");
}

async function testTunerRejectsConcurrentRuns() {
  console.log("\n== The Tuner: refuses to run twice at once, and a manual Test is refused while it's running ==");
  await resetAllParticipants();

  const firstRun = call("tuner:run", {});
  await waitUntil(() => sentLog("chatgpt").length >= 1, { label: "tuner's first check sent" });

  const secondRun = await call("tuner:run", {});
  assert(!secondRun.ok && secondRun.error === "ALREADY_RUNNING", "a second tuner run while one is active is rejected");

  const manualTest = await call("selftest:run", { site: "claude" });
  assert(!manualTest.ok && manualTest.error === "TUNER_RUNNING", "a manual 🧪 Test is refused while the tuner is running, rather than racing it");

  // let the in-flight run finish cleanly rather than leaving a dangling promise.
  // chatgpt's connectivity-check prompt was already sent (confirmed above,
  // before the ALREADY_RUNNING/TUNER_RUNNING checks) -- answer it directly
  // rather than waiting for a "new" send that will never come until it's
  // answered. claude's and gemini's checks haven't gone out yet, so those
  // two DO need to wait. Every wait from here on checks for a count past a
  // snapshotted "before", not just "length >= 1" or "contains RELAY-TEST" --
  // sites get reused across multiple legs below, and every leg's prompt
  // contains that same substring, so a non-snapshotted check would match a
  // stale, already-answered entry from an earlier leg instead of the new one.
  say("chatgpt", reverseStr(extractSelftestToken(sentLog("chatgpt")[sentLog("chatgpt").length - 1].text)));
  for (const site of ["claude", "gemini"]) {
    const before = sentLog(site).length;
    await waitUntil(() => sentLog(site).length > before, { label: `tuner check reaches ${site}` });
    const token = extractSelftestToken(sentLog(site)[sentLog(site).length - 1].text);
    say(site, reverseStr(token));
  }
  const legs = [];
  for (const source of SITES) for (const target of SITES) if (source !== target) legs.push([source, target]);
  for (const [source, target] of legs) {
    const beforeSource = sentLog(source).length;
    const beforeTarget = sentLog(target).length;
    await waitUntil(() => sentLog(source).length > beforeSource, { label: `relay prompt reaches ${source}` });
    const relayToken = sentLog(source)[sentLog(source).length - 1].text.match(/RELAY-TEST (\S+)/)[1];
    say(source, `RELAY-TEST ${relayToken}`);
    await waitUntil(() => sentLog(target).length > beforeTarget, { label: `mesh forwards to ${target}` });
    say(target, `RELAY-RECEIVED ${relayToken}`);
  }
  await firstRun;
}

async function testTunerDistinguishesForwardFailureFromNoReply() {
  console.log("\n== The Tuner: a relay leg whose internal forward silently fails to send is reported as exactly that, not confused with the target never answering ==");
  await resetAllParticipants();

  const tunerRunPromise = call("tuner:run", {});

  // Phase 1: answer all 3 connectivity checks normally
  for (const site of SITES) {
    const before = sentLog(site).length;
    await waitUntil(() => sentLog(site).length > before, { label: `tuner connectivity check reaches ${site}` });
    const token = extractSelftestToken(sentLog(site)[sentLog(site).length - 1].text);
    say(site, reverseStr(token));
  }

  const legs = [];
  for (const source of SITES) for (const target of SITES) if (source !== target) legs.push([source, target]);

  for (const [source, target] of legs) {
    const beforeSource = sentLog(source).length;
    await waitUntil(() => sentLog(source).length > beforeSource, { label: `relay prompt reaches ${source} (leg ${source}->${target})` });
    const relayToken = sentLog(source)[sentLog(source).length - 1].text.match(/RELAY-TEST (\S+)/)[1];

    if (source === "chatgpt" && target === "claude") {
      // this is the one leg whose forward we sabotage
      reg("claude").webContents._forceSendFail = true;
      say("chatgpt", `RELAY-TEST ${relayToken}`);
      await waitUntil(async () => {
        const st = await call("state:get", {});
        return st.log.some((l) => l.kind === "tuner-leg-error" && l.detail.leg === "chatgpt->claude" && l.detail.stage === "forward-send");
      }, { label: "leg chatgpt->claude reported as a forward-send failure", timeout: 30000 });
      reg("claude").webContents._forceSendFail = false;
      continue; // claude never receives anything for this leg -- nothing more to answer
    }

    const beforeTarget = sentLog(target).length;
    say(source, `RELAY-TEST ${relayToken}`);
    await waitUntil(() => sentLog(target).length > beforeTarget, { label: `mesh forwards ${source}'s reply to ${target} (leg ${source}->${target})` });
    say(target, `RELAY-RECEIVED ${relayToken}`);
  }

  const res = await tunerRunPromise;
  const leg1 = res.legs["chatgpt->claude"];
  assert(!leg1.ok && leg1.stage === "forward-send" && leg1.error === "SEND_NOT_CONFIRMED", `the leg result itself carries the forward-send stage and real error (got ${JSON.stringify(leg1)})`);
  assert(res.summary.legsOk === 5 && res.summary.legsTotal === 6, "exactly the one sabotaged leg fails, the other 5 (answered normally) still pass");
}

const MANAGER_TEST_CONFIG ={ provider: "openai-compatible", endpoint: "http://localhost:1234/v1/chat/completions", apiKey: "mgr-test-key", model: "test-model", tier: 2, timeoutMs: 5000, approvalMode: false, maximumTurns: 20, costLimit: 5 };

async function resetManagerState() {
  const s = await call("state:get", {});
  if (!["idle", "finished", "error"].includes(s.manager.status)) await call("manager:stop", {});
  resetManagerStub();
  await resetAllParticipants(); // clears sentLog/pending/captured/busy for every site -- manager tests are just as stateful as House Rules tests, same reset discipline applies
}

async function testManagerConfigureAndConnection() {
  console.log("\n== Manager: configuring the provider, and connection testing ==");
  await resetManagerState();

  const cfgRes = await call("manager:configure-provider", MANAGER_TEST_CONFIG);
  assert(cfgRes.ok, "a well-formed config is accepted");
  assert(cfgRes.config.hasApiKey === true && cfgRes.config.apiKey === undefined, "the response confirms a key is set without ever echoing the raw key back");

  const s = await call("state:get", {});
  assert(s.managerConfig.provider === "openai-compatible" && s.managerConfig.model === "test-model" && s.managerConfig.hasApiKey === true, "state:get reflects the saved config, key redacted");

  const badProvider = await call("manager:configure-provider", { provider: "not-a-real-provider" });
  assert(!badProvider.ok && badProvider.error === "BAD_PROVIDER", "an unrecognized provider is rejected");
  const badTier = await call("manager:configure-provider", { tier: 9 });
  assert(!badTier.ok && badTier.error === "BAD_TIER", "a tier outside 1-4 is rejected");

  const noConfigTest = await call("manager:test-connection", {});
  await call("manager:configure-provider", { endpoint: "", model: "" });
  const notConfigured = await call("manager:test-connection", {});
  assert(!notConfigured.ok && notConfigured.error === "NOT_CONFIGURED", "testing the connection with nothing configured is rejected before attempting any network call");
  void noConfigTest;

  // Restores real config for the network-reachability half of this check --
  // this actually calls the real (un-stubbed) askManager/testConnection
  // internals against http://localhost:1234, which nothing is listening on
  // in this sandbox, so a real, deterministic connection failure is the
  // correct and expected outcome here -- it proves the IPC plumbing and
  // error handling work end-to-end, not that a live backend exists.
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, timeoutMs: 2000 });
  const unreachable = await call("manager:test-connection", {});
  assert(unreachable.ok === false, "a configured-but-unreachable endpoint reports a real, non-crashing connection failure");
}

async function testManagerTaskLifecycleHappyPath() {
  console.log("\n== Manager: full task lifecycle -- classify/delegate, capture a real reply, finish, and check the on-disk project files ==");
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, approvalMode: false });

  const notConfiguredStart = await (async () => {
    await call("manager:configure-provider", { endpoint: "" });
    const r = await call("manager:start-task", { userRequest: "write something" });
    await call("manager:configure-provider", MANAGER_TEST_CONFIG);
    return r;
  })();
  assert(!notConfiguredStart.ok && notConfiguredStart.error === "NOT_CONFIGURED", "starting a task with no endpoint/model configured is rejected");

  const noRequest = await call("manager:start-task", { userRequest: "   " });
  assert(!noRequest.ok && noRequest.error === "NEEDS_REQUEST", "starting a task with a blank request is rejected");

  queueManagerDecision({ action: "DELEGATE", assignments: [{ target: "chatgpt", task: "Write a first draft." }], reason: "Delegating the initial draft.", confidence: 0.8 });
  const startRes = await call("manager:start-task", { userRequest: "Write me a short project summary." });
  assert(startRes.ok && !!startRes.taskId, "starting a properly-configured task succeeds and returns a taskId");

  await waitUntil(() => sentLog("chatgpt").length === 1, { label: "the DELEGATE assignment reaches chatgpt" });
  assert(sentLog("chatgpt")[0].text.includes("Write a first draft.") && sentLog("chatgpt")[0].text.includes(startRes.taskId), "the assignment text and a task-identifying wrapper both reach the real send");

  let s = await call("state:get", {});
  assert(s.manager.status === "waiting" && s.manager.pendingModels.includes("chatgpt"), "the task is now waiting on chatgpt specifically");
  assert(managerAskCalls.length === 1, "exactly one manager decision call happened before delegation paused the loop");

  queueManagerDecision({ action: "FINISH", reason: "The draft is good enough.", confidence: 0.9 });
  say("chatgpt", "Here is the draft you asked for.");
  await waitUntil(async () => (await call("state:get", {})).manager.status === "finished", { label: "the task finishes once chatgpt's reply is captured and the manager says FINISH" });

  s = await call("state:get", {});
  assert(s.manager.completedAssignments.length === 1 && s.manager.completedAssignments[0].response.includes("draft you asked for"), "the completed assignment carries the real captured response text");
  assert(s.managerLog.some((l) => l.category === "task" && l.severity === "success"), "the Manager Activity Log records task completion");
  assert(s.log.some((l) => l.kind === "manager-task"), "task events also flow into the existing global Activity Log, not just the manager-only one");

  assert(fs.existsSync(s.manager.projectDir), "a real project directory was created on disk");
  const checkpointRaw = fs.readFileSync(path.join(s.manager.projectDir, "project.json"), "utf8");
  const checkpoint = JSON.parse(checkpointRaw);
  assert(checkpoint.taskId === startRes.taskId, "the saved checkpoint reflects the actual finished task");
  const rawResponseFiles = fs.readdirSync(path.join(s.manager.projectDir, "raw-responses"));
  assert(rawResponseFiles.length === 1 && fs.readFileSync(path.join(s.manager.projectDir, "raw-responses", rawResponseFiles[0]), "utf8").includes("draft you asked for"), "the raw, unedited response was preserved on disk separately from the manager's own summary");

  const getStateRes = await call("manager:get-state", {});
  assert(getStateRes.ok && getStateRes.manager.taskId === startRes.taskId, "the dedicated manager:get-state handler returns the same task state");

  const alreadyRunning = await call("manager:start-task", { userRequest: "" });
  void alreadyRunning; // status is "finished" here, not blocking -- ALREADY_RUNNING is covered implicitly by resetManagerState()'s own guard in every other test
}

async function testManagerApprovalModeAndRejection() {
  console.log("\n== Manager: approval mode holds an action for a human decision before it ever reaches a real send ==");
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, approvalMode: true });

  // Both decisions are queued up front, before the task even starts -- the
  // FIFO queue holds the FINISH ready and waiting so it's there the instant
  // reject()'s fire-and-forget continuation asks for the next one, rather
  // than racing this test's own code to call queueManagerDecision() in time.
  queueManagerDecision({ action: "DELEGATE", assignments: [{ target: "gemini", task: "Summarize the findings." }], reason: "Needs a summary.", confidence: 0.7 });
  queueManagerDecision({ action: "FINISH", reason: "Stopping here for this test.", confidence: 0.5 });
  const startRes = await call("manager:start-task", { userRequest: "Summarize this for me." });
  assert(startRes.ok, "task starts");

  await waitUntil(async () => (await call("state:get", {})).manager.status === "paused", { label: "approval mode pauses before executing" });
  let s = await call("state:get", {});
  assert(!!s.manager.pendingApproval && s.manager.pendingApproval.action === "DELEGATE", "the proposed action is held for approval, visible to the UI");
  assert(sentLog("gemini").length === 0, "critically, nothing was actually sent yet -- approval gates real side effects, not just visibility");

  const rejectRes = await call("manager:reject", { reason: "Not ready yet." });
  assert(rejectRes.ok, "rejecting succeeds");
  assert(sentLog("gemini").length === 0, "rejecting truly never sent anything");

  // approvalMode is still ON, so the loop's very next decision (our queued
  // FINISH) also gets held for approval -- reading state here isn't safe
  // until that second pause has actually happened (reject()'s continuation
  // runs in the background), so synchronize on the state transition itself
  // rather than assuming any particular timing.
  await waitUntil(async () => (await call("state:get", {})).manager.status === "paused", { label: "after a rejection, the loop's next decision is also held for approval since approval mode is still on" });
  s = await call("state:get", {});
  assert(!!s.manager.pendingApproval && s.manager.pendingApproval.action === "FINISH", "the rejected DELEGATE is gone and a fresh decision is what's pending now");
  assert(s.manager.previousManagerActions.some((a) => a.action === "REJECTED_BY_USER" && a.reason === "Not ready yet."), "the rejection itself, with its reason, is recorded in the manager's own action history");

  await call("manager:approve", {});
  await waitUntil(async () => (await call("state:get", {})).manager.status === "finished", { label: "approving the follow-up decision lets the loop finish normally" });

  // second scenario: approving instead of rejecting actually lets the send through
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, approvalMode: true });
  queueManagerDecision({ action: "DELEGATE", assignments: [{ target: "claude", task: "Draft an outline." }], reason: "Needs an outline.", confidence: 0.75 });
  await call("manager:start-task", { userRequest: "Outline this topic." });
  await waitUntil(async () => (await call("state:get", {})).manager.status === "paused", { label: "second scenario also pauses for approval" });

  const approveRes = await call("manager:approve", {});
  assert(approveRes.ok, "approving succeeds");
  await waitUntil(() => sentLog("claude").length === 1, { label: "approving the held DELEGATE action finally lets the real send happen" });
  assert(sentLog("claude")[0].text.includes("Draft an outline."), "the send carries the exact assignment that was approved");

  await call("manager:configure-provider", { approvalMode: false }); // leave state clean for later scenarios
}

async function testManagerValidationEscalationAndMaxTurns() {
  console.log("\n== Manager: an invalid decision is rejected, escalates the tier after repeating, and a small maximumTurns cap still ends the task ==");
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, tier: 2, maximumTurns: 3, approvalMode: false });

  // this DELEGATE names a target outside chatgpt/claude/gemini -- valid per
  // manager-provider.js's own action vocabulary, but rejected by main.js's
  // deeper target-allowlist check, exactly the two-layer validation this
  // feature is built around.
  queueManagerDecisionRepeating({ action: "DELEGATE", assignments: [{ target: "some-other-model", task: "do it" }], reason: "bad target", confidence: 0.5 });

  const startRes = await call("manager:start-task", { userRequest: "This will keep failing validation." });
  assert(startRes.ok, "the task itself starts fine -- the failure is in what the manager proposes, not in starting");

  await waitUntil(async () => (await call("state:get", {})).manager.status === "error", { label: "repeated invalid decisions eventually exhaust maximumTurns and end the task" });
  const s = await call("state:get", {});
  assert(s.manager.currentTier > 2, `the tier escalated at least once while repeatedly failing to make progress (got tier ${s.manager.currentTier})`);
  assert(s.manager.previousManagerActions.some((a) => a.rejected && a.rejectReason === "BAD_ASSIGNMENT"), "each rejected decision is recorded with the specific reason it was rejected for");
  assert(s.managerLog.some((l) => l.summary.includes("MAX_TURNS_EXCEEDED")), "the Manager Activity Log explains exactly why the task ended, not just that it did");
  assert(sentLog("chatgpt").length === 0 && sentLog("claude").length === 0 && sentLog("gemini").length === 0, "an invalid target never results in an actual send to anyone");
}

async function testManagerEscalateActionAndTierFourAdjudication() {
  console.log("\n== Manager: an explicit ESCALATE action jumps straight to the requested tier, Tier 4 routes to a real AI pane instead of the configured provider, and it de-escalates back down afterward ==");
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, tier: 2, maximumTurns: 20, approvalMode: false, adjudicatorSite: "claude" });

  queueManagerDecision({ action: "ESCALATE", toTier: 4, reason: "Models disagree and need cloud adjudication." });
  const startRes = await call("manager:start-task", { userRequest: "Resolve this disagreement." });
  assert(startRes.ok, "task starts");

  await waitUntil(() => sentLog("claude").length === 1, { label: "Tier 4 sends an adjudication prompt directly to a real AI pane" });
  assert(sentLog("claude")[0].text.includes("tier 4 cloud adjudication"), "the adjudication send is clearly labeled as such");
  let s = await call("state:get", {});
  assert(s.manager.currentTier === 4, "the tier actually reached 4, exactly as the ESCALATE action requested, not just incrementally");
  assert(managerAskCalls.length === 1, "Tier 4 does NOT call the configured RunPod/Ollama/LM Studio provider at all -- only the initial ESCALATE decision did");

  queueManagerDecision({ action: "FINISH", reason: "Adjudication resolved it.", confidence: 0.9 });
  say("claude", "After reviewing both, the correct approach is X.");
  await waitUntil(async () => (await call("state:get", {})).manager.status === "finished", { label: "the loop resumes at the configured provider after the adjudicator replies, and can finish normally" });

  s = await call("state:get", {});
  assert(s.manager.currentTier < 4, `de-escalated back down from Tier 4 after making progress again (got tier ${s.manager.currentTier})`);
  assert(managerAskCalls.length === 2, "exactly one real call to the configured provider happened after de-escalating, to produce the FINISH decision");
}

async function testManagerSaveActionWritesRealFiles() {
  console.log("\n== Manager: a SAVE action writes real content to disk under the task's own final/ folder, and an unsafe path is refused ==");
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, maximumTurns: 20, approvalMode: false });

  queueManagerDecision({ action: "SAVE", filename: "summary.md", content: "# Summary\n\nAll done.", reason: "Saving the final result.", confidence: 0.9 });
  queueManagerDecision({ action: "FINISH", reason: "Saved and done.", confidence: 0.9 });
  const startRes = await call("manager:start-task", { userRequest: "Produce and save a short summary." });
  assert(startRes.ok, "task starts");

  await waitUntil(async () => (await call("state:get", {})).manager.status === "finished", { label: "SAVE needs no browser reply at all -- it's a pure Tier 0 file operation, so the task finishes immediately" });
  const s = await call("state:get", {});
  const savedPath = path.join(s.manager.projectDir, "final", "summary.md");
  assert(fs.existsSync(savedPath) && fs.readFileSync(savedPath, "utf8") === "# Summary\n\nAll done.", "the exact saved content lands on disk at the expected path");

  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, maximumTurns: 3, approvalMode: false });
  queueManagerDecisionRepeating({ action: "SAVE", filename: "../../escape.txt", content: "should never land", reason: "trying to escape the project dir", confidence: 0.5 });
  await call("manager:start-task", { userRequest: "Try to save outside the project directory." });
  await waitUntil(async () => (await call("state:get", {})).manager.status === "error", { label: "a path-traversal attempt eventually exhausts maximumTurns rather than ever succeeding" });
  const s2 = await call("state:get", {});
  assert(s2.manager.previousManagerActions.some((a) => a.rejected && a.rejectReason === "UNSAFE_PATH"), "the unsafe path is caught and rejected specifically, never silently written");
}

async function testManagerPauseResumeStop() {
  console.log("\n== Manager: pause/resume/stop controls work without disturbing an in-flight delegation ==");
  await resetManagerState();
  await call("manager:configure-provider", { ...MANAGER_TEST_CONFIG, maximumTurns: 20, approvalMode: false });

  queueManagerDecision({ action: "DELEGATE", assignments: [{ target: "chatgpt", task: "Do the thing." }], reason: "x", confidence: 0.6 });
  await call("manager:start-task", { userRequest: "Pause/resume test." });
  await waitUntil(() => sentLog("chatgpt").length === 1, { label: "delegation sent" });

  const pauseRes = await call("manager:pause", {});
  assert(pauseRes.ok, "pausing succeeds while waiting on a reply");
  let s = await call("state:get", {});
  assert(s.manager.status === "paused", "status reflects paused");

  const resumeRes = await call("manager:resume", {});
  assert(resumeRes.ok, "resuming succeeds");
  s = await call("state:get", {});
  assert(s.manager.status === "waiting" && s.manager.pendingModels.includes("chatgpt"), "resuming a task that was still waiting on a reply goes back to waiting, not straight to another decision");
  assert(sentLog("chatgpt").length === 1, "pause/resume never re-sent anything");

  const stopRes = await call("manager:stop", {});
  assert(stopRes.ok, "stopping succeeds");
  s = await call("state:get", {});
  assert(s.manager.status === "finished" && s.manager.pendingModels.length === 0, "stopping ends the task and clears anything it was still waiting on");
}

async function testAlwaysOnTagRouting() {
  console.log("\n== Roundtable v2 baseline: [TO: X] tag parsing, stripping, and routing run always, with no House Rule started ==");
  await resetAllParticipants();

  // [TO: CLAUDE] -- single relay, tag stripped, roundtableTag recorded
  let before = sentLog("claude").length;
  say("chatgpt", "[TO: CLAUDE]\nCan you write the migration script?");
  await waitUntil(() => sentLog("claude").length === before + 1, { label: "claude gets the relay" });
  const relayedText = sentLog("claude")[sentLog("claude").length - 1].text;
  assert(relayedText.includes("Can you write the migration script?") && !relayedText.includes("[TO:"), "relayed text has the tag stripped, framed with the usual [ChatGPT says] wrapper like any other forward");
  let s = await call("state:get", {});
  let turn = s.transcript.find((t) => t.site === "chatgpt" && t.text === "Can you write the migration script?");
  assert(turn && turn.roundtableTag === "CLAUDE", "the visible transcript turn is tag-stripped and carries roundtableTag");
  assert(!turn.text.includes("[TO:"), "no raw tag leaks into the visible text");

  // [TO: ALL] -- relays to the other two, not itself
  const beforeChatgpt = sentLog("chatgpt").length;
  const beforeGemini = sentLog("gemini").length;
  const beforeClaude = sentLog("claude").length;
  say("claude", "[TO: ALL]\nEveryone should review the API contract.");
  await waitUntil(() => sentLog("chatgpt").length === beforeChatgpt + 1 && sentLog("gemini").length === beforeGemini + 1, { label: "ALL relays to both others" });
  assert(sentLog("claude").length === beforeClaude, "claude itself gets no copy of its own [TO: ALL] message");

  // [TO: USER] -- visible, zero relays
  const totalBefore = totalSent();
  say("gemini", "[TO: USER]\nHere's the market research summary.");
  await waitUntil(async () => (await call("state:get", {})).transcript.some((t) => t.site === "gemini" && t.roundtableTag === "USER"), { label: "TO:USER turn appears in the transcript" });
  assert(totalSent() === totalBefore, "TO:USER triggers zero relays");
  s = await call("state:get", {});
  turn = s.transcript.find((t) => t.site === "gemini" && t.roundtableTag === "USER");
  assert(turn.text === "Here's the market research summary.", "TO:USER turn is tag-stripped");

  // [TO: NONE] -- fully hidden, zero relays
  const transcriptLenBefore = (await call("state:get", {})).transcript.length;
  const totalBefore2 = totalSent();
  say("chatgpt", "[TO: NONE]");
  await settle();
  s = await call("state:get", {});
  assert(s.transcript.length === transcriptLenBefore, "TO:NONE never appears in the transcript");
  assert(totalSent() === totalBefore2, "TO:NONE triggers zero relays");

  // missing tag -- defaults to USER per Rule 1, text left completely unstripped
  say("claude", "This has no tag at all, just plain text.");
  await waitUntil(async () => (await call("state:get", {})).transcript.some((t) => t.text === "This has no tag at all, just plain text."), { label: "no-tag reply still appears, defaulted to USER" });
  s = await call("state:get", {});
  turn = s.transcript.find((t) => t.text === "This has no tag at all, just plain text.");
  assert(turn.roundtableTag === "USER", "missing tag defaults to USER (Rule 1's documented fallback)");

  // case-insensitive tag parsing
  const beforeChatgpt2 = sentLog("chatgpt").length;
  say("gemini", "[to: chatgpt]\nHere's a lowercase-tagged message.");
  await waitUntil(() => sentLog("chatgpt").length === beforeChatgpt2 + 1, { label: "lowercase tag still parsed and routed correctly" });
  s = await call("state:get", {});
  turn = s.transcript.find((t) => t.text === "Here's a lowercase-tagged message.");
  assert(turn.roundtableTag === "CHATGPT", "tag parsing is case-insensitive");

  // self-address guard -- visible, but no send back to the same site
  const totalBefore3 = totalSent();
  say("chatgpt", "[TO: CHATGPT]\nNote to self.");
  await waitUntil(async () => (await call("state:get", {})).transcript.some((t) => t.text === "Note to self."), { label: "self-addressed reply still appears" });
  assert(totalSent() === totalBefore3, "a site addressing itself triggers no relay back to itself");
}

async function testMeshAndTagRoutingDontDoubleDispatch() {
  console.log("\n== Bugfix regression: mesh routing (Auto-Both) and a [TO: X] tag pointing at the SAME target must not both send -- confirmed real duplicate-delivery bug from a live test session ==");
  await resetAllParticipants();

  // Full mesh routing on, same as the session that originally surfaced
  // this: every site auto-forwards to every other site, AND the always-on
  // tag baseline is still live underneath it.
  await call("routing:auto-all", {});

  say("chatgpt", "[TO: CLAUDE]\nOnly claude should get exactly one copy of this.");
  await waitUntil(() => sentLog("claude").length === 1 && sentLog("gemini").length === 1, { label: "claude gets the tag relay, gemini gets the separate (correct) mesh forward" });
  await settle(); // give a would-be second (mesh) send to claude time to land if the bug were still present
  assert(sentLog("claude").length === 1, `claude (the tag's target) gets exactly ONE copy, not two (got ${sentLog("claude").length})`);
  assert(sentLog("gemini").length === 1, `gemini (not addressed by the tag) still correctly gets its own separate mesh copy, exactly one (got ${sentLog("gemini").length})`);
  assert(!sentLog("claude")[0].text.includes("[TO:"), "claude's one copy is the clean, tag-stripped version (tag routing's copy), never a raw mesh copy with the tag still embedded");
  assert(sentLog("gemini")[0].text.includes("[TO: CLAUDE]"), "gemini's mesh copy is untouched raw text, exactly as mesh routing has always forwarded it -- this reply just wasn't addressed to gemini");

  const s = await call("state:get", {});
  const claudeEntries = s.ledger.filter((e) => e.target === "claude" && e.textPreview.includes("Only claude should get exactly one copy"));
  assert(claudeEntries.length === 1 && claudeEntries[0].duplicate === false, "the delivery ledger also shows exactly one entry, correctly not flagged as a duplicate");

  // [TO: ALL] with full mesh on: every other site still gets exactly one copy, not two
  await resetAllParticipants();
  await call("routing:auto-all", {});
  say("gemini", "[TO: ALL]\nEveryone gets exactly one copy of this too.");
  await waitUntil(() => sentLog("chatgpt").length === 1 && sentLog("claude").length === 1, { label: "both other sites receive the ALL relay" });
  await settle();
  assert(sentLog("chatgpt").length === 1 && sentLog("claude").length === 1, `both get exactly one copy each, not two (got chatgpt:${sentLog("chatgpt").length}, claude:${sentLog("claude").length})`);

  await call("routing:stop-all", {});
}

async function testHouseRulesVsMeshDedup() {
  console.log("\n== Bugfix regression: an active House Rules stage's own send and a manually re-enabled mesh Auto route to the SAME target must not both fire for one turn ==");
  await resetAllParticipants();

  const startRes = await call("houserule:start", { mode: "debate", topic: "Is TDD worth it?", rounds: 0 });
  assert(startRes.ok, "debate starts successfully");
  await waitUntil(() => totalSent() === 1, { label: "debate kickoff sent to exactly one participant" });
  const kickedOff = SITES.find((s) => sentLog(s).length === 1);
  const others = SITES.filter((s) => s !== kickedOff);

  // Live repro from the audit: manually re-enable a per-pane Auto route
  // mid-run (the UI now disables this button while hr.active, but the
  // backend dedup has to hold even if this IPC channel is reached
  // directly). Wire mesh from kickedOff toward BOTH other sites, so no
  // matter which one debate's shuffled order addresses next, mesh routing
  // is already live toward it too.
  for (const t of others) {
    const r = await call("routing:set", { source: kickedOff, target: t, enabled: true });
    assert(r.ok, `mesh route ${kickedOff}->${t} enabled`);
  }

  const beforeCounts = {};
  for (const s of others) beforeCounts[s] = sentLog(s).length;
  say(kickedOff, "Opening position from the debate kickoff.");
  // BOTH other sites are expected to receive exactly one message each here:
  // debate's actual next speaker (hr.order[1], fixed by the shuffle at
  // kickoff -- which one that is isn't knowable in advance) gets debate's
  // own worded reaction, and the other one gets its own legitimate,
  // separate mesh forward (nothing dedupes a target the House Rule never
  // addressed). Wait for BOTH to grow, then identify which is which by
  // CONTENT, not by which one happens to satisfy a predicate first -- both
  // satisfy "grew by one", so array-order-dependent lookups here would be a
  // coin flip on which real speaker the shuffle picked.
  await waitUntil(() => others.every((s) => sentLog(s).length > beforeCounts[s]), { label: "both the real next speaker and the mesh-only target receive their one message" });
  await settle(); // settle window -- a would-be duplicate has time to land if the bug were still present

  for (const s of others) {
    assert(sentLog(s).length === beforeCounts[s] + 1, `${s} gets exactly ONE message for this turn, not a duplicate (got ${sentLog(s).length - beforeCounts[s]})`);
  }
  const next = others.find((s) => sentLog(s)[sentLog(s).length - 1].text.includes("Respond directly to the strongest point"));
  const other = others.find((s) => s !== next);
  assert(!!next, "exactly one of the two received debate's own worded reaction (identifying the real next speaker) -- dedup let the House Rule's send win, same as tag routing already wins over mesh");
  assert(sentLog(other)[sentLog(other).length - 1].text.includes("Opening position from the debate kickoff."), "the OTHER site's one copy is the untouched raw mesh forward (just wrapped in the usual '[X says]' framing every mesh forward gets), not a second copy of debate's own wording -- confirms this isn't two copies landing on the same site under a different guise");

  await call("houserule:stop", {});
  await call("routing:stop-all", {});
}

async function testSendFailureAutoPausesHouseRule() {
  console.log("\n== A House Rule turn whose send fails all 3 retry attempts auto-pauses the run (pauseReason: 'send-failed'), instead of leaving it silently 'active' forever waiting on a reply that can never arrive ==");
  await resetAllParticipants();

  const startRes = await call("houserule:start", { mode: "debate", topic: "Is TDD worth it?", rounds: 0 });
  assert(startRes.ok, "debate starts successfully");
  await waitUntil(() => totalSent() === 1, { label: "debate kickoff sent" });
  const kickedOff = SITES.find((s) => sentLog(s).length === 1);
  const others = SITES.filter((s) => s !== kickedOff);

  // Force EVERY other site's send to fail all 3 attempts, so whichever one
  // debate's shuffled order addresses next is guaranteed to exhaust retries.
  for (const s of others) reg(s).webContents._sendFailQueue = [true, true, true];

  say(kickedOff, "Opening position from the debate kickoff.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.paused === true, { label: "the run transitions to paused after the send fails all 3 attempts", timeout: 15000 });

  const s = await call("state:get", {});
  assert(s.houseRule.active === false && s.houseRule.paused === true, "the run is now paused, not left silently 'active' forever waiting on a reply that will never come");
  assert(s.houseRule.pauseReason === "send-failed", `paused with the specific 'send-failed' reason, distinguishable from a rate-limit pause (got ${s.houseRule.pauseReason})`);
  assert(SITES.every((site) => s.global.routing[site].length === 0), "routing was cleared when it paused, same as a rate-limit pause");
  assert(s.log.some((l) => l.kind === "houserule-paused" && l.detail.reason === "send-failed" && l.detail.mode === "debate"), "the pause is recorded in the Activity Log with the real reason and mode");
  assert(s.log.some((l) => l.kind === "send-error" && others.includes(l.detail.target) && l.detail.attempts === 3), "the underlying send failure is also logged with its real attempt count, same as any other exhausted retry");

  // resuming works the same as any other pause -- doesn't hang or error
  const resumeRes = await call("houserule:resume", {});
  assert(resumeRes.ok, "the paused run can still be resumed cleanly, same as a rate-limit pause");

  for (const site of others) reg(site).webContents._sendFailQueue = [];
  await call("houserule:stop", {});
}

async function testRetryHoldsQueueThroughBackoff() {
  console.log("\n== sendTextTo: a concurrent send to the same target waits out an in-progress retry's ENTIRE backoff, not just its current attempt (regression -- the queue slot used to be released during backoff, letting a concurrent send jump ahead and land out of order) ==");
  await resetAllParticipants();

  // First call fails once, then succeeds on retry -- forces exactly one
  // ~1.5s backoff sleep.
  reg("gemini").webContents._sendFailQueue = [true, false];
  const pFirst = call("send:compose", { text: "First (retries once)", targets: ["gemini"] });

  // Fire a second, unrelated send to the SAME target while the first is
  // still mid-backoff (well before its ~1.5s backoff elapses).
  await settle(200);
  const pSecond = call("send:compose", { text: "Second (fired during first's backoff)", targets: ["gemini"] });

  await Promise.all([pFirst, pSecond]);

  const log = sentLog("gemini");
  assert(log.length === 2, `both sends eventually land (got ${log.length})`);
  assert(log[0].text === "First (retries once)" && log[1].text === "Second (fired during first's backoff)", `the first call's message lands before the second's, even though the second was fired while the first was only mid-backoff -- got [${log.map((e) => e.text).join(", ")}]`);
}

async function testRegenerateGoesThroughLedgerQueueRetry() {
  console.log("\n== Bugfix regression: Regenerate now goes through sendTextTo() -- the delivery ledger, the per-target send queue, and the 3-attempt retry -- instead of bypassing all three ==");
  await resetAllParticipants();

  const composeRes = await call("send:compose", { text: "Original message", targets: ["claude"] });
  assert(composeRes.ok, "initial compose succeeds");
  await settle(50);

  const before = (await call("state:get", {})).ledger.length;
  const regenRes = await call("send:regenerate", "claude");
  assert(regenRes.ok, "regenerate succeeds");
  assert(sentLog("claude").length === 2 && sentLog("claude")[1].text === sentLog("claude")[0].text, "regenerate re-sends the exact same text that was actually sent last time, verbatim (not re-wrapped in another layer of framing)");

  const s = await call("state:get", {});
  const entries = s.ledger.slice(before);
  assert(entries.length === 1, `regenerate now records its own ledger entry, where it previously recorded none at all (got ${entries.length})`);
  assert(entries[0].target === "claude" && entries[0].status === "delivered", "the regenerate's ledger entry reflects a real delivered send");
  assert(entries[0].duplicate === true, "correctly flagged duplicate:true -- a regenerate IS an intentional re-send of identical text, and the ledger surfaces that rather than hiding it");

  // regenerate now also gets the 3-attempt retry it never had before
  await resetAllParticipants();
  await call("send:compose", { text: "Will need a retry to regenerate", targets: ["gemini"] });
  await settle(50);
  reg("gemini").webContents._sendFailQueue = [true, false];
  const beforeRetry = (await call("state:get", {})).ledger.length;
  const regenRetryRes = await call("send:regenerate", "gemini");
  assert(regenRetryRes.ok, "a regenerate that needs a retry still eventually succeeds");
  const sRetry = await call("state:get", {});
  const retryEntry = sRetry.ledger.slice(beforeRetry).find((e) => e.target === "gemini");
  assert(retryEntry && retryEntry.attempts === 2, `the regenerate's ledger entry shows the real attempt count -- it self-recovered via retry, same as any other send path (got ${JSON.stringify(retryEntry)})`);
  assert(sRetry.log.some((l) => l.kind === "send-retry" && l.detail.target === "gemini"), "the failed first attempt is logged as a retry, same as any other send");

  // an unknown site is rejected cleanly, consistent with every other site-scoped handler
  const badRes = await call("send:regenerate", "not-a-real-site");
  assert(!badRes.ok && badRes.error === "BAD_SITE", "an invalid site is rejected as BAD_SITE");
}

async function testStageOverridesBaseline() {
  console.log("\n== A House Rule 'stage' suspends tag-routing while active, and tag-routing resumes automatically once it's stopped ==");
  await resetAllParticipants();

  const startRes = await call("houserule:start", { mode: "debate", topic: "Is TDD worth it?", rounds: 2 });
  assert(startRes.ok, "debate stage starts successfully");
  await waitUntil(() => totalSent() === 1, { label: "debate kickoff sent to exactly one participant" });
  const kickedOff = SITES.find((s) => sentLog(s).length === 1);

  const totalBefore = totalSent();
  say(kickedOff, "[TO: CLAUDE]\nThis looks like a routing tag, but debate is running so it should be ignored as one.");
  await waitUntil(() => totalSent() > totalBefore, { label: "debate's own state machine sends the next turn" });
  const afterDebateTurn = totalSent();
  assert(afterDebateTurn === totalBefore + 1, "exactly one send happened (debate's own next-speaker logic), not a tag-routed relay on top of it");
  const s = await call("state:get", {});
  const turn = s.transcript.find((t) => t.text.includes("This looks like a routing tag"));
  assert(turn && !turn.roundtableTag, "while a stage is active, captured turns get no roundtableTag at all -- the [TO: CLAUDE] text is left as plain, untouched dialogue");

  await call("houserule:stop", {});
  await resetAllParticipants();

  // now that the stage is stopped, tag-routing resumes underneath with no extra action needed
  const before2 = sentLog("claude").length;
  say("chatgpt", "[TO: CLAUDE]\nStage is stopped now, so this really is a routing tag.");
  await waitUntil(() => sentLog("claude").length === before2 + 1, { label: "tag-routing resumes automatically once the stage is stopped" });
  const s2 = await call("state:get", {});
  const turn2 = s2.transcript.find((t) => t.text === "Stage is stopped now, so this really is a routing tag.");
  assert(turn2 && turn2.roundtableTag === "CLAUDE", "the post-stage turn is tag-parsed again, same as baseline");
}

async function testEndTagCompletion() {
  console.log("\n== End-tag protocol: a baseline reply is captured only once it closes with [FROM: X] (no stability timer) ==");
  await resetAllParticipants();

  // An untagged reply (still 'streaming', or the AI forgot to close it) must
  // NEVER be captured — the old 'text stopped changing' timer no longer applies.
  sayRaw("claude", "[TO: USER]\nHere is a draft answer, but I have not closed it yet");
  await settle(); // longer than the (fast) watchdog window, so we'd see any capture
  let s = await call("state:get", {});
  assert(!s.transcript.some((t) => t.text.includes("draft answer, but I have not closed")),
    "an untagged reply is never captured, no matter how long it sits");

  // The moment the [FROM:] closing tag lands, it's captured — tag(s) stripped.
  reg("claude").webContents.currentText = "[TO: USER]\nHere is a draft answer, but I have not closed it yet\n[FROM: CLAUDE]";
  await waitUntil(async () => (await call("state:get", {})).transcript.some((t) => t.text.includes("draft answer, but I have not closed")),
    { label: "the reply captures as soon as [FROM:] appears" });
  s = await call("state:get", {});
  const turn = s.transcript.find((t) => t.text.includes("draft answer"));
  assert(turn && !/\[FROM:/i.test(turn.text) && !/\[TO:/i.test(turn.text), "both envelope tags are stripped from the captured text");
}

async function testMissingEndTagReprompt() {
  console.log("\n== Missing end-tag watchdog: an untagged reply is discarded and the AI is re-sent the protocol, capped so it can't loop ==");
  await resetAllParticipants();
  const isNudge = (e) => /NO ENDING TAG RECEIVED/i.test(e.text);

  sayRaw("gemini", "[TO: USER]\nFirst attempt with no closing tag");
  await waitUntil(() => sentLog("gemini").some(isNudge), { label: "the AI is nudged to resend with the [FROM:] tag" });
  let s = await call("state:get", {});
  assert(!s.transcript.some((t) => t.text.includes("First attempt with no closing tag")), "the untagged reply is never captured (treated as lost)");
  const nudge = sentLog("gemini").find(isNudge);
  assert(/\[FROM: GEMINI\]/.test(nudge.text) && /resend/i.test(nudge.text), "the nudge tells gemini to resend with its own closing tag");

  // Recovery: the AI resends the WHOLE message with the tag -> captured normally.
  reg("gemini").webContents.currentText = "[TO: USER]\nFirst attempt with no closing tag\n[FROM: GEMINI]";
  await waitUntil(async () => (await call("state:get", {})).transcript.some((t) => t.text.includes("First attempt with no closing tag")),
    { label: "the resent, properly-tagged message is captured" });

  // Cap: chatgpt's counter is fresh (reset by resetAllParticipants). Four distinct
  // untagged messages must NOT yield four nudges — the watchdog gives up after
  // MAX_NOTAG_REPROMPTS so a forgetful model can't be nudged forever.
  const nudges = () => sentLog("chatgpt").filter(isNudge).length;
  for (let i = 1; i <= 4; i++) {
    sayRaw("chatgpt", `Untagged try number ${i}, still no closing tag`);
    await settle(450); // > watchdog window, so each distinct message fires (or gives up)
  }
  assert(nudges() >= 1 && nudges() <= 2, `the resend nudge is capped, not fired once per attempt (got ${nudges()} for 4 untagged messages)`);
}

async function testSelftestLeavesNoMissingTagNudge() {
  console.log("\n== Regression: a finished self-test's bare-token reply must NOT trip a spurious missing-[FROM:] nudge ==");
  await resetAllParticipants();
  const isNudge = (e) => /NO ENDING TAG RECEIVED/i.test(e.text);
  const p = call("selftest:run", { site: "claude" });
  await waitUntil(() => sentLog("claude").length === 1, { label: "self-test prompt sent" });
  const token = extractSelftestToken(sentLog("claude")[0].text);
  sayRaw("claude", reverseStr(token)); // bare reversed token, no envelope — exactly what the test asks for
  const res = await p;
  assert(res.ok === true, "the self-test passes on the bare reversed token");
  // The bare token now lingers in the pane; give the watchdog well past its window.
  await settle(600);
  assert(!sentLog("claude").some(isNudge), "no missing-tag nudge is sent for the leftover self-test reply once the test ends");
}

async function main() {
  // Seed a plausible saved-state file BEFORE main.js is first required, so its
  // startup loadPersistedState() call actually has something to restore —
  // this has to happen here (not as a normal test-after-require scenario)
  // since main.js's app.whenReady() handler only fires once per process.
  // 1050 synthetic entries (oldest first) plus the real "Restored opening
  // message" as the newest, so the SAME seed also exercises the transcript
  // cap (MAX_TRANSCRIPT = 1000) on load, not just restoration itself.
  const oldTranscript = [];
  for (let i = 0; i < 1050; i++) oldTranscript.push({ id: i + 1, site: "chatgpt", label: "ChatGPT", text: `synthetic old turn #${i}`, ts: Date.now() - (1050 - i) * 1000, pinned: false });
  oldTranscript.push({ id: 1051, site: "chatgpt", label: "ChatGPT", text: "Restored opening message", ts: Date.now() - 10000, pinned: false });

  const seedFile = path.join(mockElectron.__userDataDir, "autoinjector-state.json");
  fs.writeFileSync(seedFile, JSON.stringify({
    schemaVersion: 1,
    savedAt: Date.now(),
    transcript: oldTranscript,
    customRole: { chatgpt: "", claude: "Skeptical Engineer", gemini: "" },
    hr: { mode: "rotation", topic: "Restored topic", rounds: 0, roundNum: 2, order: ["chatgpt", "claude", "gemini"], phase: "rotating", lastSpeakerIndex: 0, roles: {} }
  }));

  require(path.join(__dirname, "..", "main.js"));
  // QA-001: wait for the ACTUAL startup work to finish (the routing-explainer
  // auto-send reaching all three panes) instead of a fixed 100ms guess — this is
  // the terminal, observable signal that app.whenReady()→createWindow ran.
  const started = await waitUntil(() => SITES.every((s) => {
    const r = reg(s); // the registry is populated only once createWindow runs
    return r && r.webContents && Array.isArray(r.webContents.sentLog) && r.webContents.sentLog.length >= 1;
  }), { label: "startup routing-explainer sent to all three panes" });
  assert(!!started, "startup completed (routing-explainer auto-sent to all three panes)");

  console.log("\n== Persistence: restores transcript/roles/House Rule state on startup ==");
  const restored = await call("state:get", {});
  assert(restored.transcript.length === 1000, `transcript is capped to MAX_TRANSCRIPT (1000) on load, even when the saved file has more (got ${restored.transcript.length})`);
  assert(restored.transcript[restored.transcript.length - 1].text === "Restored opening message", "the most recent entry survives the cap");
  assert(restored.transcript[0].text === "synthetic old turn #51", "the cap evicts from the OLDEST end, keeping exactly the newest 1000");
  assert(restored.global.customRole.claude === "Skeptical Engineer", "custom roles restored from disk");
  assert(restored.houseRule.mode === "rotation" && restored.houseRule.topic === "Restored topic", "House Rule mode/topic restored");
  assert(restored.houseRule.active === false, "restored run comes back NOT active — a restart must never auto-send anything");
  assert(restored.houseRule.paused === true, "restored run shows as paused, so the user can hit Resume deliberately");
  assert(restored.houseRule.nextSpeaker === "claude", "nextSpeaker computed correctly from the restored order/phase/lastSpeakerIndex");

  console.log("\n== Startup: the routing-explainer prompt is auto-sent to every site once, before anything else ==");
  for (const s of SITES) {
    assert(sentLog(s).length === 1, `${s} received exactly one send on startup (got ${sentLog(s).length})`);
    // QA-001: never index [0] blindly after a count assertion — guard it so a
    // miss reports a clean failure instead of crashing the whole runner.
    assert(sentLog(s)[0] && sentLog(s)[0].text.includes("[TO:"), `${s}'s startup send is the [TO: X] routing explainer, not something else`);
  }

  await testDebate();
  await testDevilAngel();
  await testChargeback();
  await testWhoWantsToSpeak();
  await testFreeForAllAndBrainstormTeardown();
  await testParticipantDisableRemovesAsTarget();
  await testRotation();
  await testBlindRound();
  await testPauseResume();
  await testRoleInjection();
  await testWindowCollapse();
  await testRateLimitAutoPause();
  await testRateLimitDetectedOutsideHouseRules();
  await testWaitingSinceTracking();
  await testConcurrentSendsToSameTargetAreSerialized();
  await testSendAutoRetry();
  await testDeliveryLedger();
  await testPersistenceSavesToDisk();
  await testPromptLibrary();
  await testPromptEditorWindow();
  await testDocumentSendHappyPath();
  await testDocumentSendNoFileInputFound();
  await testDocumentSendSetFilesFails();
  await testDocumentSendAttachFails();
  await testDocumentSendFileNotFoundOrNoTargets();
  await testDocumentRead();
  await testDocumentChooseAndViewerWindow();
  await testSequenceWindowManagement();
  await testSequenceBackend();
  await testSequenceRejectsWhileRunningAndInvalidSteps();
  await testZoomIPC();
  testSelectorOverridePriorityInScripts();
  await testSelectorPicker();
  await testSelectorPickerValidation();
  await testSavedLogins();
  await testSelfTestConnectivity();
  await testTunerFullRun();
  await testTunerRejectsConcurrentRuns();
  await testTunerDistinguishesForwardFailureFromNoReply();
  await testManagerConfigureAndConnection();
  await testManagerTaskLifecycleHappyPath();
  await testManagerApprovalModeAndRejection();
  await testManagerValidationEscalationAndMaxTurns();
  await testManagerEscalateActionAndTierFourAdjudication();
  await testManagerSaveActionWritesRealFiles();
  await testManagerPauseResumeStop();
  await testAlwaysOnTagRouting();
  await testMeshAndTagRoutingDontDoubleDispatch();
  await testHouseRulesVsMeshDedup();
  await testSendFailureAutoPausesHouseRule();
  await testRetryHoldsQueueThroughBackoff();
  await testRegenerateGoesThroughLedgerQueueRetry();
  await testStageOverridesBaseline();
  await testEndTagCompletion();
  await testMissingEndTagReprompt();
  await testSelftestLeavesNoMissingTagNudge();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
