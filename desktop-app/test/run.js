// test/run.js — drives the real main.js through its actual IPC handlers with a
// mocked Electron layer (see mock-electron.js), simulating replies and checking
// what gets sent next. Exercises the House Rules state machines and routing
// logic for real; does not (and cannot, without a browser) test the DOM
// automation itself. Run with: node test/run.js
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

  const explainer = state0.prompts.find((p) => p.name === "System Prompt (How Routing Works)");
  assert(!!explainer, "a second built-in prompt explaining [TO: X] tag routing also exists by default");
  assert(explainer.text.chatgpt.includes("[TO:") && explainer.text.claude.includes("[TO:") && explainer.text.gemini.includes("[TO:"), "every AI's version actually mentions the [TO: X] tag syntax");
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
  await new Promise((r) => setTimeout(r, 3000));
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

  await new Promise((r) => setTimeout(r, 700)); // let the debounced save flush
  const raw = fs.readFileSync(path.join(mockElectron.__userDataDir, "autoinjector-state.json"), "utf8");
  const saved = JSON.parse(raw);
  assert(saved.selectorOverrides && saved.selectorOverrides.claude && saved.selectorOverrides.claude.input === '[data-testid="composer-input"]', "the override survives to the persisted state file");

  reg("gemini").webContents._nextPickResult = { ok: true, selector: "div.reply-body", tag: "div", sample: "Hello there" };
  const pickRes2 = await call("selector:pick", { site: "gemini", role: "assistant" });
  assert(pickRes2.ok && pickRes2.sample === "Hello there", "a different site/role picks independently and returns its own sample text");
  s = await call("state:get", {});
  assert(!s.global.selectorOverrides.claude.assistant, "claude's assistant role is untouched by gemini's pick");
  assert(s.global.selectorOverrides.gemini.assistant === "div.reply-body", "gemini's assistant override is stored separately");

  reg("chatgpt").webContents._nextPickResult = { ok: false, error: "TIMEOUT" };
  const timeoutRes = await call("selector:pick", { site: "chatgpt", role: "send" });
  assert(!timeoutRes.ok && timeoutRes.error === "TIMEOUT", "a pick that times out (no click) is reported, not silently ignored");
  s = await call("state:get", {});
  assert(JSON.stringify(s.global.selectorOverrides.chatgpt) === "{}", "a failed pick never stores an override");

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

  console.log("\n== Startup: the routing-explainer prompt is auto-sent to every site once, before anything else ==");
  for (const s of SITES) {
    assert(sentLog(s).length === 1, `${s} received exactly one send on startup (got ${sentLog(s).length})`);
    assert(sentLog(s)[0].text.includes("[TO:"), `${s}'s startup send is the [TO: X] routing explainer, not something else`);
  }

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
  await testAlwaysOnTagRouting();
  await testStageOverridesBaseline();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
