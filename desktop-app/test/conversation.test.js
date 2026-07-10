// test/conversation.test.js — runs the REAL conversation.html/conversation.js in
// a jsdom (in-memory DOM, no real browser or Electron needed) with window.api
// stubbed out the same way preload.js exposes it. This is the counterpart to
// test/run.js: that one drives main.js's IPC handlers directly; this one drives
// the renderer that main.js's IPC handlers ultimately talk to, so button clicks,
// rendering, and event wiring in conversation.js get exercised for real instead
// of just re-read by eye. Run with: node test/conversation.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

// A tiny fake of window.api: records every call, lets the test script the
// resolved value, and captures the onCapture/onHouseRuleState callbacks so
// tests can fire simulated events exactly like main.js's broadcast() would.
function makeApi() {
  const calls = [];
  let captureCb = null;
  let houseRuleCb = null;
  const api = {
    calls,
    fireCapture: (turn) => captureCb && captureCb(turn),
    fireHouseRuleState: (hr) => houseRuleCb && houseRuleCb(hr),
    getState: async () => api.__state,
    sendCompose: async (text, targets) => { calls.push({ fn: "sendCompose", text, targets }); return { ok: true }; },
    startHouseRule: async (mode, topic, rounds) => {
      calls.push({ fn: "startHouseRule", mode, topic, rounds });
      return api.__startHouseRuleResult || { ok: true, houseRule: { mode, active: true, paused: false, topic, rounds: 0, roundNum: 0, nextSpeaker: "chatgpt" } };
    },
    pauseHouseRule: async () => { calls.push({ fn: "pauseHouseRule" }); return { ok: true, houseRule: { mode: "rotation", active: false, paused: true, topic: "t", roundNum: 1, nextSpeaker: "claude" } }; },
    resumeHouseRule: async () => { calls.push({ fn: "resumeHouseRule" }); return { ok: true, houseRule: { mode: "rotation", active: true, paused: false, topic: "t", roundNum: 1, nextSpeaker: "claude" } }; },
    stopHouseRule: async () => { calls.push({ fn: "stopHouseRule" }); return { ok: true, houseRule: { mode: null, active: false, paused: false, topic: "", roundNum: 0, nextSpeaker: null } }; },
    setRole: async (site, role) => { calls.push({ fn: "setRole", site, role }); return { ok: true }; },
    onCapture: (cb) => { captureCb = cb; },
    onHouseRuleState: (cb) => { houseRuleCb = cb; }
  };
  api.__state = { ok: true, transcript: [], houseRule: { mode: null, active: false, paused: false, topic: "", roundNum: 0, nextSpeaker: null }, global: { customRole: {} } };
  return api;
}

async function loadWindow(api) {
  const html = fs.readFileSync(path.join(__dirname, "..", "conversation.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/conversation.html" });
  dom.window.api = api;
  const script = fs.readFileSync(path.join(__dirname, "..", "conversation.js"), "utf8");
  dom.window.eval(script);
  // hydrate() is fired at the bottom of conversation.js and is async — let it settle.
  await new Promise((r) => setTimeout(r, 20));
  return dom;
}

function click(dom, id) {
  dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

function setMsg(dom, text) {
  dom.window.document.getElementById("msg-box").value = text;
}

async function testAutoStartOnFirstSend() {
  console.log("\n== Send auto-starts Rotation when nothing is running yet ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  setMsg(dom, "What's the best way to learn a language?");
  click(dom, "btn-send");
  await new Promise((r) => setTimeout(r, 20));

  assert(api.calls.length === 1 && api.calls[0].fn === "startHouseRule", "clicking Send with nothing running calls startHouseRule, not sendCompose");
  assert(api.calls[0].mode === "rotation" && api.calls[0].topic === "What's the best way to learn a language?", "the typed message becomes the rotation's topic");
  assert(dom.window.document.getElementById("msg-box").value === "", "message box is cleared after auto-starting");
  assert(dom.window.document.getElementById("run-status").textContent === "Running", "status line reflects the run starting");
}

async function testSendInterjectsOnceRunning() {
  console.log("\n== Send just interjects once Rotation is already active ==");
  const api = makeApi();
  api.__state.houseRule = { mode: "rotation", active: true, paused: false, topic: "existing topic", roundNum: 1, nextSpeaker: "claude" };
  const dom = await loadWindow(api);

  setMsg(dom, "one more thing to consider");
  click(dom, "btn-send");
  await new Promise((r) => setTimeout(r, 20));

  assert(api.calls.length === 1 && api.calls[0].fn === "sendCompose", "clicking Send while active calls sendCompose, not startHouseRule");
  assert(JSON.stringify(api.calls[0].targets.slice().sort()) === JSON.stringify(["chatgpt", "claude", "gemini"]), "sendCompose targets all three AIs");
}

async function testTranscriptRendersAndHidesInternals() {
  console.log("\n== Transcript renders real turns; nothing internal ever arrives to hide ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "Let's talk about space travel." });
  api.fireCapture({ id: 2, site: "claude", label: "Claude", text: "Sure — where do you want to start?" });
  await new Promise((r) => setTimeout(r, 20));

  const turns = dom.window.document.querySelectorAll("#transcript .turn");
  assert(turns.length === 2, `both captured turns rendered (got ${turns.length})`);
  assert(turns[0].textContent.includes("ChatGPT") && turns[0].textContent.includes("space travel"), "first turn shows the right speaker and text");
  assert(!dom.window.document.getElementById("transcript").textContent.includes("UPDATED"), "no 'UPDATED' text anywhere in the rendered transcript (none was ever sent to it)");

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "Let's talk about space travel." });
  await new Promise((r) => setTimeout(r, 20));
  assert(dom.window.document.querySelectorAll("#transcript .turn").length === 2, "re-delivering the same turn id doesn't duplicate it");
}

async function testSpeakerChipsAndButtons() {
  console.log("\n== Speaker chips and button enable/disable follow houseRule-state ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "opening" });
  api.fireHouseRuleState({ mode: "rotation", active: true, paused: false, topic: "t", roundNum: 0, nextSpeaker: "claude" });
  await new Promise((r) => setTimeout(r, 20));

  const chatgptChip = dom.window.document.querySelector('.speaker-chip[data-site="chatgpt"]');
  const claudeChip = dom.window.document.querySelector('.speaker-chip[data-site="claude"]');
  assert(chatgptChip.classList.contains("current"), "chatgpt (most recent speaker) is marked current");
  assert(claudeChip.classList.contains("next"), "claude (houseRule.nextSpeaker) is marked next");
  assert(dom.window.document.getElementById("btn-start").disabled === true, "Start is disabled while active");
  assert(dom.window.document.getElementById("btn-pause").disabled === false, "Pause is enabled while active");
  assert(dom.window.document.getElementById("btn-resume").disabled === true, "Resume is disabled while active (not paused)");

  api.fireHouseRuleState({ mode: "rotation", active: false, paused: true, topic: "t", roundNum: 0, nextSpeaker: "claude" });
  await new Promise((r) => setTimeout(r, 20));
  assert(dom.window.document.getElementById("btn-pause").disabled === true, "Pause disabled once paused");
  assert(dom.window.document.getElementById("btn-resume").disabled === false, "Resume enabled once paused");
  assert(dom.window.document.getElementById("btn-start").disabled === true, "Start stays disabled while paused (starting fresh would reset the run)");
}

async function testRoleAssignment() {
  console.log("\n== Role Assignment: Apply/Clear wire through to setRole ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  dom.window.document.getElementById("role-claude").value = "Skeptical Engineer";
  dom.window.document.querySelector('.role-apply[data-site="claude"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert(api.calls.some((c) => c.fn === "setRole" && c.site === "claude" && c.role === "Skeptical Engineer"), "Apply calls setRole with the typed role");
  assert(dom.window.document.getElementById("role-current-claude").textContent.includes("Skeptical Engineer"), "current-role label updates after Apply");

  dom.window.document.querySelector('.role-clear[data-site="claude"]').dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "setRole" && c.site === "claude" && c.role === ""), "Clear calls setRole with an empty role");
  assert(dom.window.document.getElementById("role-current-claude").textContent === "", "current-role label clears too");
}

async function main() {
  await testAutoStartOnFirstSend();
  await testSendInterjectsOnceRunning();
  await testTranscriptRendersAndHidesInternals();
  await testSpeakerChipsAndButtons();
  await testRoleAssignment();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
