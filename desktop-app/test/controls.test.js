// test/controls.test.js — runs the REAL controls.html/controls.js in jsdom
// with window.api stubbed the way preload.js exposes it, focused on the
// window/pane collapse feature added alongside conversation.js's collapse
// support (see conversation.test.js's matching suite). Doesn't re-test
// every existing button — test/run.js already covers the backend logic
// those call into; this is specifically about DOM behavior that only lives
// in controls.js itself. Run with: node test/controls.test.js
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

function makeApi() {
  const calls = [];
  let windowCollapseCb = null;
  let captureCb = null;
  const noop = async () => ({ ok: true });
  const api = {
    calls,
    fireWindowCollapseChanged: (payload) => windowCollapseCb && windowCollapseCb(payload),
    fireCapture: (turn) => captureCb && captureCb(turn),
    sendCompose: noop, sendForward: noop, regenerate: noop, setRouting: noop,
    pauseAllRouting: noop, stopAllRouting: noop, autoAllRouting: noop,
    setParticipant: noop,
    startHouseRule: async (mode, topic, rounds) => { calls.push({ fn: "startHouseRule", mode, topic, rounds }); return { ok: true, houseRule: { mode, active: true, paused: false, topic, rounds, roundNum: 0, roles: {}, nextSpeaker: null } }; },
    stopHouseRule: async () => { calls.push({ fn: "stopHouseRule" }); return { ok: true, houseRule: { mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null }, global: { routing: { chatgpt: [], claude: [], gemini: [] }, enabled: {}, waiting: {}, meshActive: false, customRole: {} } }; },
    pauseHouseRule: noop, resumeHouseRule: noop, wrapUpBrainstorm: noop,
    setRole: noop, clearTranscript: noop, togglePin: noop, reloadSite: noop,
    inspectSite: noop,
    listSites: async () => ({ ok: true, sites: { chatgpt: null, claude: null, gemini: null } }),
    toggleWindowCollapse: async (which) => { calls.push({ fn: "toggleWindowCollapse", which }); return { ok: true, which, collapsed: true }; },
    getState: async () => ({
      ok: true,
      global: { routing: { chatgpt: [], claude: [], gemini: [] }, enabled: { chatgpt: true, claude: true, gemini: true }, waiting: {}, meshActive: false, customRole: {} },
      houseRule: { mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null },
      captured: { chatgpt: null, claude: null, gemini: null },
      transcript: [],
      log: []
    }),
    onCapture: (cb) => { captureCb = cb; }, onSent: () => {}, onSendError: () => {}, onWaitingChanged: () => {},
    onHouseRuleState: () => {}, onLog: () => {},
    onWindowCollapseChanged: (cb) => { windowCollapseCb = cb; }
  };
  return api;
}

async function loadWindow(api, { confirmReturns = true } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "controls.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/controls.html" });
  dom.window.api = api;
  dom.window.confirm = () => confirmReturns;
  // controls.js uses navigator.clipboard, which jsdom doesn't implement — stub
  // it so loading the script doesn't throw when it wires up the Copy button.
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  const script = fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8");
  dom.window.eval(script);
  await new Promise((r) => setTimeout(r, 20));
  return dom;
}

function click(dom, id) {
  dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

async function testPaneCollapseToggle() {
  console.log("\n== Per-AI pane collapse toggle ==");
  const dom = await loadWindow(makeApi());

  const col = dom.window.document.getElementById("col-claude");
  assert(!!col, "buildAiRow() created a column for claude");
  assert(!col.classList.contains("collapsed"), "starts expanded");

  const btn = col.querySelector(".collapse-btn");
  assert(!!btn, "each column has its own collapse button");
  assert(btn.textContent === "⌄", "starts with the 'collapse' icon");

  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(col.classList.contains("collapsed"), "clicking it adds the 'collapsed' class");
  assert(btn.textContent === "›", "icon flips to the 'expand' state");

  const otherCol = dom.window.document.getElementById("col-chatgpt");
  assert(!otherCol.classList.contains("collapsed"), "collapsing claude's pane does NOT collapse chatgpt's — each is independent");

  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!col.classList.contains("collapsed"), "clicking again expands it back");
  assert(btn.textContent === "⌄", "icon flips back to 'collapse'");
}

async function testWindowTitlebarCollapse() {
  console.log("\n== Automation window titlebar collapse ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  click(dom, "btn-collapse-window");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "toggleWindowCollapse" && c.which === "automation"), "clicking the titlebar button calls toggleWindowCollapse('automation')");

  api.fireWindowCollapseChanged({ which: "conversation", collapsed: true });
  assert(!dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "a collapse event for the OTHER window ('conversation') is ignored here");

  api.fireWindowCollapseChanged({ which: "automation", collapsed: true });
  assert(dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "a collapse event for THIS window hides the main body");

  api.fireWindowCollapseChanged({ which: "automation", collapsed: false });
  assert(!dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "expanding again shows the body");
}

async function testHouseRuleStopConfirmation() {
  console.log("\n== House Rules Stop asks for confirmation before ending the run ==");
  const apiCancel = makeApi();
  const domCancel = await loadWindow(apiCancel, { confirmReturns: false });
  click(domCancel, "btn-hr-stop");
  await new Promise((r) => setTimeout(r, 20));
  assert(!apiCancel.calls.some((c) => c.fn === "stopHouseRule"), "declining the confirm() dialog does NOT call stopHouseRule");

  const apiConfirm = makeApi();
  const domConfirm = await loadWindow(apiConfirm, { confirmReturns: true });
  click(domConfirm, "btn-hr-stop");
  await new Promise((r) => setTimeout(r, 20));
  assert(apiConfirm.calls.some((c) => c.fn === "stopHouseRule"), "accepting the confirm() dialog does call stopHouseRule");
}

async function testRoundtableDropdownOption() {
  console.log("\n== Roundtable v2 dropdown option and start dispatch ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  const option = dom.window.document.querySelector('#hr-mode option[value="roundtable"]');
  assert(!!option, "hr-mode has a roundtable option");
  assert(option.textContent.includes("Roundtable v2") && option.textContent.includes("needs 3"), `option label is descriptive (got "${option.textContent}")`);

  dom.window.document.getElementById("hr-mode").value = "roundtable";
  dom.window.document.getElementById("composer-text").value = "Plan the launch";
  dom.window.document.getElementById("hr-rounds").value = "15";
  click(dom, "btn-hr-start");
  await new Promise((r) => setTimeout(r, 20));

  const startCall = api.calls.find((c) => c.fn === "startHouseRule");
  assert(!!startCall && startCall.mode === "roundtable" && startCall.topic === "Plan the launch" && startCall.rounds === 15, "selecting Roundtable v2 and clicking Start calls startHouseRule with the right mode/topic/rounds");
}

async function testRoundtableBadgeParity() {
  console.log("\n== Automation window's transcript also shows the roundtable routing badge ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "Do this", roundtableTag: "CLAUDE", ts: Date.now(), pinned: false });
  await new Promise((r) => setTimeout(r, 20));

  const badge = dom.window.document.querySelector("#transcript .turn .badge-roundtable");
  assert(!!badge, "a roundtableTag on a turn renders a badge in the Automation window's transcript too");
  if (badge) assert(badge.textContent === "→ Claude", `badge text is correct (got "${badge.textContent}")`);
}

async function main() {
  await testPaneCollapseToggle();
  await testWindowTitlebarCollapse();
  await testHouseRuleStopConfirmation();
  await testRoundtableDropdownOption();
  await testRoundtableBadgeParity();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
