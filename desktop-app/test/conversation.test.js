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
  let windowCollapseCb = null;
  let waitingChangedCb = null;
  let sendErrorCb = null;
  const api = {
    calls,
    fireCapture: (turn) => captureCb && captureCb(turn),
    fireHouseRuleState: (hr) => houseRuleCb && houseRuleCb(hr),
    fireWindowCollapseChanged: (payload) => windowCollapseCb && windowCollapseCb(payload),
    fireWaitingChanged: (payload) => waitingChangedCb && waitingChangedCb(payload),
    fireSendError: (payload) => sendErrorCb && sendErrorCb(payload),
    getState: async () => api.__state,
    sendCompose: async (text, targets) => { calls.push({ fn: "sendCompose", text, targets }); return { ok: true }; },
    startHouseRule: async (mode, topic, rounds) => {
      calls.push({ fn: "startHouseRule", mode, topic, rounds });
      return api.__startHouseRuleResult || { ok: true, houseRule: { mode, active: true, paused: false, topic, rounds: 0, roundNum: 0, nextSpeaker: "chatgpt" } };
    },
    pauseHouseRule: async () => { calls.push({ fn: "pauseHouseRule" }); return { ok: true, houseRule: { mode: "roundtable", active: false, paused: true, topic: "t", roundNum: 1, nextSpeaker: "claude" } }; },
    resumeHouseRule: async () => { calls.push({ fn: "resumeHouseRule" }); return { ok: true, houseRule: { mode: "roundtable", active: true, paused: false, topic: "t", roundNum: 1, nextSpeaker: "claude" } }; },
    stopHouseRule: async () => { calls.push({ fn: "stopHouseRule" }); return { ok: true, houseRule: { mode: null, active: false, paused: false, topic: "", roundNum: 0, nextSpeaker: null } }; },
    setRole: async (site, role) => { calls.push({ fn: "setRole", site, role }); return { ok: true }; },
    toggleWindowCollapse: async (which) => { calls.push({ fn: "toggleWindowCollapse", which }); return { ok: true, which, collapsed: true }; },
    onCapture: (cb) => { captureCb = cb; },
    onHouseRuleState: (cb) => { houseRuleCb = cb; },
    onWindowCollapseChanged: (cb) => { windowCollapseCb = cb; },
    onWaitingChanged: (cb) => { waitingChangedCb = cb; },
    onSendError: (cb) => { sendErrorCb = cb; }
  };
  api.__state = { ok: true, transcript: [], houseRule: { mode: null, active: false, paused: false, topic: "", roundNum: 0, nextSpeaker: null }, global: { customRole: {}, waiting: {} } };
  return api;
}

async function loadWindow(api, { confirmReturns = true } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "conversation.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/conversation.html" });
  dom.window.api = api;
  dom.window.confirm = () => confirmReturns;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text) => { dom.window.__clipboardText = text; } }, configurable: true });
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
  console.log("\n== Send auto-starts the roundtable when nothing is running yet ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  setMsg(dom, "What's the best way to learn a language?");
  click(dom, "btn-send");
  await new Promise((r) => setTimeout(r, 20));

  assert(api.calls.length === 1 && api.calls[0].fn === "startHouseRule", "clicking Send with nothing running calls startHouseRule, not sendCompose");
  assert(api.calls[0].mode === "roundtable" && api.calls[0].topic === "What's the best way to learn a language?", "the typed message becomes the roundtable's topic");
  assert(dom.window.document.getElementById("msg-box").value === "", "message box is cleared after auto-starting");
  assert(dom.window.document.getElementById("run-status").textContent === "Running", "status line reflects the run starting");
}

async function testSendInterjectsOnceRunning() {
  console.log("\n== Send just interjects once the roundtable is already active ==");
  const api = makeApi();
  api.__state.houseRule = { mode: "roundtable", active: true, paused: false, topic: "existing topic", roundNum: 1, nextSpeaker: "claude" };
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
  api.fireHouseRuleState({ mode: "roundtable", active: true, paused: false, topic: "t", roundNum: 0, nextSpeaker: "claude" });
  await new Promise((r) => setTimeout(r, 20));

  const chatgptChip = dom.window.document.querySelector('.speaker-chip[data-site="chatgpt"]');
  const claudeChip = dom.window.document.querySelector('.speaker-chip[data-site="claude"]');
  assert(chatgptChip.classList.contains("current"), "chatgpt (most recent speaker) is marked current");
  assert(claudeChip.classList.contains("next"), "claude (houseRule.nextSpeaker) is marked next");
  assert(dom.window.document.getElementById("btn-start").disabled === true, "Start is disabled while active");
  assert(dom.window.document.getElementById("btn-pause").disabled === false, "Pause is enabled while active");
  assert(dom.window.document.getElementById("btn-resume").disabled === true, "Resume is disabled while active (not paused)");

  api.fireHouseRuleState({ mode: "roundtable", active: false, paused: true, topic: "t", roundNum: 0, nextSpeaker: "claude" });
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

async function testWindowCollapseToggle() {
  console.log("\n== Window titlebar collapse button wires through and hides the body ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  click(dom, "btn-collapse-window");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "toggleWindowCollapse" && c.which === "conversation"), "clicking the titlebar button calls toggleWindowCollapse('conversation')");

  // main.js broadcasts the actual result back to every window: only react to
  // events naming THIS window, and let the broadcast (not the click) be what
  // drives the visible state, since main.js is the source of truth.
  api.fireWindowCollapseChanged({ which: "automation", collapsed: true });
  await new Promise((r) => setTimeout(r, 20));
  assert(!dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "a collapse event for the OTHER window ('automation') is ignored here");

  api.fireWindowCollapseChanged({ which: "conversation", collapsed: true });
  await new Promise((r) => setTimeout(r, 20));
  assert(dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "a collapse event for THIS window hides the main body");
  assert(dom.window.document.getElementById("btn-collapse-window").textContent === "›", "the button's own icon flips to the 'expand' state");

  api.fireWindowCollapseChanged({ which: "conversation", collapsed: false });
  await new Promise((r) => setTimeout(r, 20));
  assert(!dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "expanding again shows the body");
}

async function testSendErrorBanner() {
  console.log("\n== send-error shows a clean, generic banner — never the raw internal error ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireSendError({ target: "claude", error: "SELECTOR_NOT_FOUND: div.font-claude-response-body missing from DOM" });
  await new Promise((r) => setTimeout(r, 20));

  const banner = dom.window.document.getElementById("banner");
  assert(banner.classList.contains("show") && banner.classList.contains("error"), "banner becomes visible, styled as an error");
  assert(banner.textContent.includes("Claude"), "banner names the AI that had trouble");
  assert(!banner.textContent.includes("SELECTOR_NOT_FOUND") && !banner.textContent.includes("font-claude-response-body"), "the raw internal error string never appears in the banner");

  dom.window.document.getElementById("btn-banner-dismiss").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(!banner.classList.contains("show"), "Dismiss hides the banner");
}

async function testRateLimitBanner() {
  console.log("\n== Rate-limit auto-pause shows/clears a distinct banner, tied to houseRule.pauseReason ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireHouseRuleState({ mode: "roundtable", active: false, paused: true, pauseReason: "rate-limit", topic: "t", roundNum: 1, nextSpeaker: "claude" });
  await new Promise((r) => setTimeout(r, 20));
  const banner = dom.window.document.getElementById("banner");
  assert(banner.classList.contains("show") && banner.classList.contains("warn"), "a rate-limit pause shows a warning banner");
  assert(dom.window.document.getElementById("run-status").textContent.includes("usage limit"), "status line also mentions the usage limit");

  api.fireHouseRuleState({ mode: "roundtable", active: true, paused: false, pauseReason: null, topic: "t", roundNum: 1, nextSpeaker: "gemini" });
  await new Promise((r) => setTimeout(r, 20));
  assert(!banner.classList.contains("show"), "banner clears automatically once the run resumes (pauseReason back to null)");
}

async function testRateLimitedTurnStyling() {
  console.log("\n== A turn marked isRateLimited renders with a distinct badge ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "You've reached your usage limit.", isRateLimited: true });
  await new Promise((r) => setTimeout(r, 20));

  const turn = dom.window.document.querySelector("#transcript .turn");
  assert(turn.classList.contains("rate-limited"), "the turn element gets the rate-limited class");
  assert(turn.textContent.includes("USAGE LIMIT"), "a visible badge explains why, right in the transcript");
}

async function testGeneratingPulse() {
  console.log("\n== onWaitingChanged drives the 'generating' pulse on a speaker chip ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireWaitingChanged({ site: "gemini", waiting: true });
  await new Promise((r) => setTimeout(r, 20));
  assert(dom.window.document.querySelector('.speaker-chip[data-site="gemini"]').classList.contains("generating"), "chip gets the 'generating' class while waiting on that AI");

  api.fireWaitingChanged({ site: "gemini", waiting: false });
  await new Promise((r) => setTimeout(r, 20));
  assert(!dom.window.document.querySelector('.speaker-chip[data-site="gemini"]').classList.contains("generating"), "class clears once the reply lands");
}

async function testStructuralRoleTags() {
  console.log("\n== Structural House Rule roles (Devil/Angel/etc.) show on the speaker chips ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireHouseRuleState({ mode: "devil-angel", active: true, paused: false, topic: "t", roundNum: 0, nextSpeaker: null, roles: { chatgpt: "middle", claude: "devil", gemini: "angel" } });
  await new Promise((r) => setTimeout(r, 20));

  assert(dom.window.document.querySelector('.speaker-chip[data-site="chatgpt"] .role-tag').textContent === "MIDDLE", "chatgpt's structural role (Middle) shows on its chip");
  assert(dom.window.document.querySelector('.speaker-chip[data-site="claude"] .role-tag').textContent === "DEVIL", "claude's structural role (Devil) shows too");
}

async function testStopConfirmation() {
  console.log("\n== Stop asks for confirmation before actually ending the run ==");
  const apiCancel = makeApi();
  const domCancel = await loadWindow(apiCancel, { confirmReturns: false });
  click(domCancel, "btn-stop");
  await new Promise((r) => setTimeout(r, 20));
  assert(!apiCancel.calls.some((c) => c.fn === "stopHouseRule"), "declining the confirm() dialog does NOT call stopHouseRule");

  const apiConfirm = makeApi();
  const domConfirm = await loadWindow(apiConfirm, { confirmReturns: true });
  click(domConfirm, "btn-stop");
  await new Promise((r) => setTimeout(r, 20));
  assert(apiConfirm.calls.some((c) => c.fn === "stopHouseRule"), "accepting the confirm() dialog does call stopHouseRule");
}

async function testEnterToSend() {
  console.log("\n== Enter sends; Shift+Enter does not ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  setMsg(dom, "hello via enter key");
  const box = dom.window.document.getElementById("msg-box");
  box.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "startHouseRule" && c.topic === "hello via enter key"), "plain Enter triggers Send");

  const api2 = makeApi();
  const dom2 = await loadWindow(api2);
  setMsg(dom2, "hello via shift enter");
  const box2 = dom2.window.document.getElementById("msg-box");
  box2.dispatchEvent(new dom2.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api2.calls.length === 0, "Shift+Enter does NOT send (leaves room for a newline instead)");
}

async function testExport() {
  console.log("\n== Copy/Download export the visible conversation ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "Exported reply text." });
  await new Promise((r) => setTimeout(r, 20));

  click(dom, "btn-copy");
  await new Promise((r) => setTimeout(r, 20));
  assert(typeof dom.window.__clipboardText === "string" && dom.window.__clipboardText.includes("Exported reply text."), "Copy puts the real transcript text on the clipboard");
  assert(dom.window.__clipboardText.includes("ChatGPT"), "export includes the speaker's name");
}

async function testTitleFlashOnLiveReply() {
  console.log("\n== Title flashes on a live reply when the window isn't focused (jsdom defaults to unfocused) ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  const before = dom.window.document.title;
  assert(!before.includes("🔔"), "title starts clean");

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "New reply while you're away." });
  await new Promise((r) => setTimeout(r, 20));
  assert(dom.window.document.title.includes("🔔"), "title flashes to flag a new reply arrived");

  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await new Promise((r) => setTimeout(r, 20));
  assert(!dom.window.document.title.includes("🔔"), "title resets back to normal once the window regains focus");
}

async function testHopsInput() {
  console.log("\n== Hops input: defaults to 24, its value is passed through as the hop limit ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  const hopsInput = dom.window.document.getElementById("hr-hops");
  assert(!!hopsInput && hopsInput.type === "number", "#hr-hops exists and is a number input");
  assert(hopsInput.value === "24", "defaults to 24");

  setMsg(dom, "Plan the roadmap");
  click(dom, "btn-send");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls[0].mode === "roundtable" && api.calls[0].rounds === 24, "Send with the default Hops value starts roundtable mode with rounds:24");

  const api2 = makeApi();
  const dom2 = await loadWindow(api2);
  dom2.window.document.getElementById("hr-hops").value = "8";
  dom2.window.document.getElementById("msg-box").value = "Different topic";
  click(dom2, "btn-start");
  await new Promise((r) => setTimeout(r, 20));
  assert(api2.calls[0].rounds === 8, "changing the Hops value before Start passes the new value through");

  const api3 = makeApi();
  const dom3 = await loadWindow(api3);
  dom3.window.document.getElementById("hr-hops").value = ""; // cleared/invalid
  dom3.window.document.getElementById("msg-box").value = "Yet another topic";
  click(dom3, "btn-start");
  await new Promise((r) => setTimeout(r, 20));
  assert(api3.calls[0].rounds === 24, "an empty/invalid Hops value falls back to the 24 default rather than sending NaN/0");
}

async function testRoundtableAckStatus() {
  console.log("\n== Status line shows ack-phase progress, distinct from the normal Running/Paused states ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireHouseRuleState({ mode: "roundtable", active: true, paused: false, topic: "t", roundNum: 0, nextSpeaker: null, phase: "ack", ackPending: ["claude", "gemini"] });
  await new Promise((r) => setTimeout(r, 20));
  const status = dom.window.document.getElementById("run-status").textContent;
  assert(status.includes("acknowledge") && status.includes("1/3"), `status shows ack progress (got: "${status}")`);

  api.fireHouseRuleState({ mode: "roundtable", active: true, paused: false, topic: "t", roundNum: 0, nextSpeaker: null, phase: "active", ackPending: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert(dom.window.document.getElementById("run-status").textContent === "Running", "status returns to the normal 'Running' text once phase flips to active");
}

async function testRoundtableTagBadge() {
  console.log("\n== Turns show a routing badge for their [TO: X] tag, except plain USER ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "Can you write this?", roundtableTag: "CLAUDE" });
  api.fireCapture({ id: 2, site: "claude", label: "Claude", text: "Everyone should see this.", roundtableTag: "ALL" });
  api.fireCapture({ id: 3, site: "gemini", label: "Gemini", text: "Here's the answer.", roundtableTag: "USER" });
  await new Promise((r) => setTimeout(r, 20));

  const turns = dom.window.document.querySelectorAll("#transcript .turn");
  assert(turns[0].querySelector(".badge-roundtable").textContent === "→ Claude", "a CLAUDE-tagged turn shows a '→ Claude' badge");
  assert(turns[1].querySelector(".badge-roundtable").textContent === "→ Everyone", "an ALL-tagged turn shows a '→ Everyone' badge");
  assert(!turns[2].querySelector(".badge-roundtable"), "a USER-tagged turn (the common case) shows no badge at all");
}

async function main() {
  await testAutoStartOnFirstSend();
  await testSendInterjectsOnceRunning();
  await testTranscriptRendersAndHidesInternals();
  await testSpeakerChipsAndButtons();
  await testRoleAssignment();
  await testWindowCollapseToggle();
  await testSendErrorBanner();
  await testRateLimitBanner();
  await testRateLimitedTurnStyling();
  await testGeneratingPulse();
  await testStructuralRoleTags();
  await testStopConfirmation();
  await testEnterToSend();
  await testExport();
  await testTitleFlashOnLiveReply();
  await testHopsInput();
  await testRoundtableAckStatus();
  await testRoundtableTagBadge();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
