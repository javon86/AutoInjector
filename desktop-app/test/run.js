// test/run.js — drives the real main.js through its actual IPC handlers with a
// mocked Electron layer (see mock-electron.js), simulating replies and checking
// what gets sent next. Exercises the House Rules state machines and routing
// logic for real; does not (and cannot, without a browser) test the DOM
// automation itself. Run with: node test/run.js
const path = require("path");
const fs = require("fs");
const Module = require("module");

const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);

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
  await new Promise((r) => setTimeout(r, 400)); // let any in-flight poll tick from the prior scenario drain
}

function say(site, text) {
  reg(site).webContents.currentText = text;
}

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
  await new Promise((r) => setTimeout(r, 500)); // settle margin to catch any stray extra send
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
  await new Promise((r) => setTimeout(r, 3000));
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
  await new Promise((r) => setTimeout(r, 3000));
  const state1 = await call("state:get", {});
  assert(state1.houseRule.active === true, "referee's acknowledgment does not end or advance the run");

  say(d1, "Remote work removes commute time entirely.");
  await waitUntil(() => sentLog(d2).length === 1, { label: "debater1's opening forwarded to debater2" });
  const refCopiesAfterD1 = sentLog(referee).length;
  assert(refCopiesAfterD1 === 2, `referee got an informational copy of debater1's statement (sentLog=${refCopiesAfterD1})`);

  say(referee, "Noted.");
  await new Promise((r) => setTimeout(r, 3000));

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
  await new Promise((r) => setTimeout(r, 2000));
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
  await new Promise((r) => setTimeout(r, 3000));
  const afterUpdateAck = await call("state:get", {});
  assert(afterUpdateAck.transcript.every((t) => t.text !== "UPDATED"), "gemini's 'UPDATED' ack never lands in the transcript");
  assert(sentLog("claude").length === 1 && sentLog("chatgpt").length === 1, "gemini's silent ack doesn't trigger any further sends");

  say("claude", "Claude's reply responding to chatgpt");
  await waitUntil(() => sentLog("gemini").length === 2 && sentLog("chatgpt").length === 2, { label: "claude's reply fans out RESPOND to gemini, UPDATE to chatgpt" });
  assert(sentLog("gemini")[1].text.includes("Respond to this, continuing"), "gemini gets a real RESPOND turn this time");
  assert(sentLog("chatgpt")[1].text.includes("reply with exactly: UPDATED"), "chatgpt gets UPDATEd since it's not its turn");

  say("chatgpt", "UPDATED");
  await new Promise((r) => setTimeout(r, 3000));

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
  const convWin = mockElectron.__windowRegistry["AutoInjector — Conversation"];
  assert(!!automationWin && !!convWin, "both real BaseWindows are reachable via the mock registry");

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

  // Conversation window has an explicit minHeight (500) set at construction —
  // collapsing to a 44px titlebar only works if that minimum is temporarily
  // relaxed, and it must be put back afterward, not left at 44 forever (which
  // would silently block the user from ever resizing it back up normally).
  assert(convWin.getMinimumSize()[1] === 500, "sanity: Conversation window's real minHeight is 500 before collapsing");
  await call("window:toggle-collapse", { which: "conversation" });
  assert(convWin.getBounds().height === 44, "Conversation window (which has a real minHeight) also collapses to 44px");
  assert(convWin.getMinimumSize()[1] === 44, "its minimum height is relaxed while collapsed, or setBounds would just get clamped back up to 500");
  await call("window:toggle-collapse", { which: "conversation" });
  assert(convWin.getBounds().height === 860, "expanding restores its original height (constructed at 860)");
  assert(convWin.getMinimumSize()[1] === 500, "its minHeight constraint is restored too, not left at 44 permanently");
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

async function testPersistenceSavesToDisk() {
  console.log("\n== Persistence: role/state changes get written to disk (debounced) ==");
  await resetAllParticipants();
  await call("roles:set", { site: "gemini", role: "Fact-checker" });
  await new Promise((r) => setTimeout(r, 700)); // let the debounced save flush
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  const saved = JSON.parse(raw);
  assert(saved.customRole && saved.customRole.gemini === "Fact-checker", "the file on disk reflects the new role");
  await call("roles:set", { site: "gemini", role: "" }); // leave roles clean for later tests
  await new Promise((r) => setTimeout(r, 700));
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

  await new Promise((r) => setTimeout(r, 700)); // let the debounced save flush
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  const saved = JSON.parse(raw);
  assert(Array.isArray(saved.prompts) && !saved.prompts.some((p) => p.id === created.id), "the deletion is reflected in the persisted state file too");
}

async function startRoundtableAndSkipAcks(topic, rounds) {
  await call("houserule:start", { mode: "roundtable", topic, rounds });
  await waitUntil(() => sentLog("chatgpt").length === 1 && sentLog("claude").length === 1 && sentLog("gemini").length === 1, { label: "house-rules kickoff sent to all three" });
  say("chatgpt", "[TO: USER] Acknowledged, understood.");
  say("claude", "[TO: USER] Acknowledged, understood.");
  say("gemini", "[TO: USER] Acknowledged, understood.");
  await waitUntil(() => sentLog("chatgpt").length === 2 && sentLog("claude").length === 2 && sentLog("gemini").length === 2, { label: "real topic sent to all three once every ack lands" });
}

async function testRoundtableAckHandshake() {
  console.log("\n== Roundtable: acknowledgment handshake is fully hidden, real topic sent only once all three ack ==");
  await resetAllParticipants();
  const startRes = await call("houserule:start", { mode: "roundtable", topic: "Let's plan a product launch", rounds: 10 });
  assert(startRes.ok, "starts successfully");
  await waitUntil(() => sentLog("chatgpt").length === 1 && sentLog("claude").length === 1 && sentLog("gemini").length === 1, { label: "house-rules kickoff sent to all three" });
  assert(sentLog("claude")[0].text.includes("ROLE ADDENDUM") && sentLog("claude")[0].text.includes("code generation"), "claude gets its own role addendum in the kickoff");
  assert(sentLog("gemini")[0].text.includes("NotebookLM"), "gemini gets its own role addendum in the kickoff");
  assert(sentLog("chatgpt")[0].text.includes("human-language reasoning"), "chatgpt gets its own role addendum in the kickoff");

  const state0 = await call("state:get", {});
  assert(state0.houseRule.phase === "ack", "phase is 'ack' immediately after start");
  assert(state0.houseRule.ackPending.length === 3, "all three are pending ack");
  assert(state0.transcript.length === 0, "nothing in the transcript yet");

  // acks arrive out of order: gemini, then chatgpt, then claude last
  say("gemini", "[TO: USER] Acknowledged. I understand the rules and my role.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.ackPending.length === 2, { label: "gemini's ack consumed" });
  let s = await call("state:get", {});
  assert(s.transcript.length === 0, "gemini's ack never appears in the transcript");
  assert(sentLog("chatgpt").length === 1 && sentLog("claude").length === 1, "no real topic sent yet — still waiting on 2 more acks");

  say("chatgpt", "[TO: USER] Acknowledged, I got it.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.ackPending.length === 1, { label: "chatgpt's ack consumed" });
  assert(sentLog("chatgpt").length === 1, "still no real topic sent — claude hasn't acked yet");

  say("claude", "[TO: USER] Acknowledged, understood.");
  await waitUntil(() => sentLog("chatgpt").length === 2 && sentLog("claude").length === 2 && sentLog("gemini").length === 2, { label: "real topic sent to all three once the last ack lands" });
  assert(sentLog("chatgpt")[1].text === "Let's plan a product launch", "the real topic (raw, no wrapper) goes out once acks are complete");
  const s2 = await call("state:get", {});
  assert(s2.houseRule.phase === "active", "phase flips to active");
  assert(s2.transcript.length === 0, "still nothing visible in the transcript — only acks and the kickoff have happened so far");

  await call("houserule:stop", {});
}

async function testRoundtableDuplicateAck() {
  console.log("\n== Roundtable: a duplicate ack from an already-acked site doesn't cause problems ==");
  await resetAllParticipants();
  await call("houserule:start", { mode: "roundtable", topic: "Topic X", rounds: 10 });
  await waitUntil(() => sentLog("chatgpt").length === 1, { label: "kickoff sent" });

  say("chatgpt", "[TO: USER] Acknowledged.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.ackPending.length === 2, { label: "chatgpt acked" });

  say("chatgpt", "[TO: USER] Acknowledged again, just in case."); // a stray second reply from an already-acked site
  await new Promise((r) => setTimeout(r, 3000));
  const s = await call("state:get", {});
  assert(s.houseRule.ackPending.length === 2, "still exactly 2 pending — the duplicate didn't remove anyone twice or error");
  assert(s.transcript.length === 0, "still nothing visible");

  await call("houserule:stop", {});
}

async function testRoundtableTagRouting() {
  console.log("\n== Roundtable: [TO: X] tag parsing, stripping, and routing ==");
  await resetAllParticipants();
  await startRoundtableAndSkipAcks("Discuss project X", 30);

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
  await new Promise((r) => setTimeout(r, 3000));
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

  await call("houserule:stop", {});
}

async function testRoundtableHopLimit() {
  console.log("\n== Roundtable: hop limit stops the run, [TO: ALL] costs 2 hops ==");
  await resetAllParticipants();
  await startRoundtableAndSkipAcks("Short hop-limited topic", 3);

  say("chatgpt", "[TO: CLAUDE]\nHop 1.");
  await waitUntil(() => sentLog("claude").length === 3, { label: "hop 1 relay sent" });
  let s = await call("state:get", {});
  assert(s.houseRule.active === true && s.houseRule.roundNum === 1, "1 hop consumed, still running");

  say("claude", "[TO: ALL]\nHop 2 and 3 -- broadcasts to both others.");
  await waitUntil(async () => (await call("state:get", {})).houseRule.active === false, { label: "run ends once the hop limit (3) is reached by this 2-hop broadcast" });
  s = await call("state:get", {});
  assert(s.houseRule.roundNum === 3, `roundNum reflects exactly 3 hops consumed (got ${s.houseRule.roundNum})`);
  assert(sentLog("chatgpt").length === 3 && sentLog("gemini").length === 3, "both chatgpt and gemini got the [TO: ALL] broadcast before the run ended");
}

async function testRoundtableDefaultHopLimit() {
  console.log("\n== Roundtable: rounds<=0 defaults to a real hop limit, not unlimited ==");
  await resetAllParticipants();
  const res = await call("houserule:start", { mode: "roundtable", topic: "No explicit hop limit given", rounds: 0 });
  assert(res.ok, "starts successfully even with rounds:0");
  const s = await call("state:get", {});
  assert(s.houseRule.rounds === 24, `rounds:0 is overridden to a real default (got ${s.houseRule.rounds}) — the rules text promises the AIs a real limit exists`);
  await call("houserule:stop", {});
}

async function main() {
  // Seed a plausible saved-state file BEFORE main.js is first required, so its
  // startup loadPersistedState() call actually has something to restore —
  // this has to happen here (not as a normal test-after-require scenario)
  // since main.js's app.whenReady() handler only fires once per process.
  const seedFile = path.join(mockElectron.__userDataDir, "autoinjector-state.json");
  fs.writeFileSync(seedFile, JSON.stringify({
    schemaVersion: 1,
    savedAt: Date.now(),
    transcript: [{ id: 1, site: "chatgpt", label: "ChatGPT", text: "Restored opening message", ts: Date.now() - 10000, pinned: false }],
    customRole: { chatgpt: "", claude: "Skeptical Engineer", gemini: "" },
    hr: { mode: "rotation", topic: "Restored topic", rounds: 0, roundNum: 2, order: ["chatgpt", "claude", "gemini"], phase: "rotating", lastSpeakerIndex: 0, roles: {} }
  }));

  require(path.join(__dirname, "..", "main.js"));
  await new Promise((r) => setTimeout(r, 100)); // let app.whenReady().then(createWindow) settle

  console.log("\n== Persistence: restores transcript/roles/House Rule state on startup ==");
  const restored = await call("state:get", {});
  assert(restored.transcript.length === 1 && restored.transcript[0].text === "Restored opening message", "transcript restored from disk on startup");
  assert(restored.global.customRole.claude === "Skeptical Engineer", "custom roles restored from disk");
  assert(restored.houseRule.mode === "rotation" && restored.houseRule.topic === "Restored topic", "House Rule mode/topic restored");
  assert(restored.houseRule.active === false, "restored run comes back NOT active — a restart must never auto-send anything");
  assert(restored.houseRule.paused === true, "restored run shows as paused, so the user can hit Resume deliberately");
  assert(restored.houseRule.nextSpeaker === "claude", "nextSpeaker computed correctly from the restored order/phase/lastSpeakerIndex");

  await testDebate();
  await testDevilAngel();
  await testChargeback();
  await testWhoWantsToSpeak();
  await testFreeForAllAndBrainstormTeardown();
  await testParticipantDisableRemovesAsTarget();
  await testRotation();
  await testPauseResume();
  await testRoleInjection();
  await testWindowCollapse();
  await testRateLimitAutoPause();
  await testWaitingSinceTracking();
  await testPersistenceSavesToDisk();
  await testPromptLibrary();
  await testRoundtableAckHandshake();
  await testRoundtableDuplicateAck();
  await testRoundtableTagRouting();
  await testRoundtableHopLimit();
  await testRoundtableDefaultHopLimit();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
