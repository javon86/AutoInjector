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

function makeApi({ initialPrompts } = {}) {
  const calls = [];
  let windowCollapseCb = null;
  let captureCb = null;
  let houseRuleCb = null;
  let promptsChangedCb = null;
  let prompts = initialPrompts || [{ id: 1, name: "System Test", text: { chatgpt: "hi chatgpt", claude: "hi claude", gemini: "hi gemini" } }];
  let nextPromptId = prompts.reduce((m, p) => Math.max(m, p.id + 1), 1);
  const noop = async () => ({ ok: true });
  const api = {
    calls,
    fireWindowCollapseChanged: (payload) => windowCollapseCb && windowCollapseCb(payload),
    fireCapture: (turn) => captureCb && captureCb(turn),
    fireHouseRuleState: (hr) => houseRuleCb && houseRuleCb(hr),
    firePromptsChanged: (p) => promptsChangedCb && promptsChangedCb(p),
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
    savePrompt: async (id, name, text) => {
      calls.push({ fn: "savePrompt", id, name, text });
      const cleanText = { chatgpt: (text && text.chatgpt) || "", claude: (text && text.claude) || "", gemini: (text && text.gemini) || "" };
      const existing = id != null ? prompts.find((p) => p.id === id) : null;
      if (existing) { existing.name = name; existing.text = cleanText; }
      else { prompts.push({ id: nextPromptId++, name, text: cleanText }); }
      return { ok: true, prompts };
    },
    deletePrompt: async (id) => {
      calls.push({ fn: "deletePrompt", id });
      prompts = prompts.filter((p) => p.id !== id);
      return { ok: true, prompts };
    },
    sendPrompt: async (text) => {
      const targets = ["chatgpt", "claude", "gemini"].filter((s) => text && String(text[s] || "").trim());
      calls.push({ fn: "sendPrompt", text, targets });
      if (!targets.length) return { ok: false, error: "NEED_TEXT" };
      return { ok: true, results: {} };
    },
    openPromptEditor: async (id) => { calls.push({ fn: "openPromptEditor", id }); return { ok: true }; },
    getState: async () => ({
      ok: true,
      global: { routing: { chatgpt: [], claude: [], gemini: [] }, enabled: { chatgpt: true, claude: true, gemini: true }, waiting: {}, meshActive: false, customRole: {} },
      houseRule: { mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null },
      captured: { chatgpt: null, claude: null, gemini: null },
      transcript: [],
      log: [],
      prompts
    }),
    onCapture: (cb) => { captureCb = cb; }, onSent: () => {}, onSendError: () => {}, onWaitingChanged: () => {},
    onHouseRuleState: (cb) => { houseRuleCb = cb; }, onLog: () => {},
    onWindowCollapseChanged: (cb) => { windowCollapseCb = cb; },
    onPromptsChanged: (cb) => { promptsChangedCb = cb; }
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

async function testHouseRuleModeHidesManualControls() {
  console.log("\n== Manual Forward/Auto buttons hide once a House Rules format is in play ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  const aiRow = dom.window.document.getElementById("ai-row");
  assert(!aiRow.classList.contains("hr-active"), "no House Rule ever run yet — manual controls stay visible");

  api.fireHouseRuleState({ mode: "roundtable", active: true, paused: false, topic: "x", rounds: 24, roundNum: 1, roles: {}, nextSpeaker: null, phase: "active", ackPending: [] });
  assert(aiRow.classList.contains("hr-active"), "starting Roundtable v2 hides the manual Forward/Auto rows");

  api.fireHouseRuleState({ mode: "roundtable", active: false, paused: false, topic: "x", rounds: 24, roundNum: 24, roles: {}, nextSpeaker: null, phase: "active", ackPending: [] });
  assert(aiRow.classList.contains("hr-active"), "still hidden once the run finishes (hop limit reached) — mode is still 'roundtable', just not active");

  api.fireHouseRuleState({ mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null });
  assert(!aiRow.classList.contains("hr-active"), "mode reset back to null (e.g. after Stop clears it) shows the manual controls again");
}

async function testCollapsedPanesMoveToTheirOwnStrip() {
  console.log("\n== Collapsing a pane saves space — it moves into the shared #collapsed-strip beside House Rules, not a narrow column ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;

  assert(doc.getElementById("col-houserules").contains(doc.getElementById("collapsed-strip")), "#collapsed-strip lives inside House Rules, in its otherwise-unused space");

  const claudeCol = doc.getElementById("col-claude");
  assert(doc.getElementById("expanded-strip").contains(claudeCol), "expanded by default — lives in the side-by-side strip");
  assert(!doc.getElementById("collapsed-strip").contains(claudeCol), "not in the collapsed strip yet");

  claudeCol.querySelector(".collapse-btn").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(doc.getElementById("collapsed-strip").contains(claudeCol), "collapsing moves it into the shared collapsed strip");
  assert(!doc.getElementById("expanded-strip").contains(claudeCol), "...and out of the side-by-side strip");
  assert(doc.getElementById("col-chatgpt") && doc.getElementById("expanded-strip").contains(doc.getElementById("col-chatgpt")), "the other, still-expanded panes are unaffected");

  claudeCol.querySelector(".collapse-btn").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(doc.getElementById("expanded-strip").contains(claudeCol), "expanding it again moves it back");
  assert(!doc.getElementById("collapsed-strip").contains(claudeCol), "...and out of the collapsed strip");
}

async function testAllPanesCollapsedExpandsTranscript() {
  console.log("\n== Collapsing every AI pane hands its space to the Transcript/Log panel ==");
  const dom = await loadWindow(makeApi());
  const wrap = dom.window.document.getElementById("wrap");

  const collapseBtn = (site) => dom.window.document.getElementById(`col-${site}`).querySelector(".collapse-btn");
  assert(!wrap.classList.contains("all-collapsed"), "starts expanded — no extra space handed over yet");

  collapseBtn("claude").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!wrap.classList.contains("all-collapsed"), "only one of three collapsed — not enough to hand over space yet");

  collapseBtn("chatgpt").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  collapseBtn("gemini").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(wrap.classList.contains("all-collapsed"), "all three collapsed — Transcript/Log panel grows into the freed space");

  collapseBtn("claude").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!wrap.classList.contains("all-collapsed"), "expanding just one pane again gives the space back");
}

async function testPromptLibraryDropdownRenders() {
  console.log("\n== Prompt Library: a compact dropdown, not inline cards ==");
  const dom = await loadWindow(makeApi({
    initialPrompts: [
      { id: 1, name: "System Test", text: { chatgpt: "a", claude: "b", gemini: "c" } },
      { id: 2, name: "Kickoff", text: { chatgpt: "x", claude: "", gemini: "" } }
    ]
  }));
  const doc = dom.window.document;
  const sel = doc.getElementById("prompt-select");

  assert(sel.options.length === 2, `both saved prompts appear as options (got ${sel.options.length})`);
  assert(sel.options[0].textContent === "System Test" && sel.options[1].textContent === "Kickoff", "options are labeled by name");
  assert(!doc.getElementById("btn-prompt-send").disabled, "Send is enabled once something's selected (first option, by default)");
  assert(!doc.querySelector(".prompt-card"), "no inline per-AI text boxes/cards render anymore");
}

async function testPromptLibraryEmptyState() {
  console.log("\n== Prompt Library: no saved prompts yet ==");
  const dom = await loadWindow(makeApi({ initialPrompts: [] }));
  const doc = dom.window.document;
  assert(doc.getElementById("prompt-select").options.length === 1, "a single placeholder option shows instead of an empty dropdown");
  assert(doc.getElementById("btn-prompt-send").disabled, "Send is disabled when there's nothing to select");
  assert(doc.getElementById("btn-prompt-delete").disabled, "Delete is disabled too");
}

async function testPromptLibrarySend() {
  console.log("\n== Prompt Library Send uses the selected prompt's saved text ==");
  const api = makeApi({
    initialPrompts: [{ id: 1, name: "Kickoff", text: { chatgpt: "hi chatgpt", claude: "", gemini: "hi gemini" } }]
  });
  const dom = await loadWindow(api);
  click(dom, "btn-prompt-send");
  await new Promise((r) => setTimeout(r, 20));

  const sendCall = api.calls.find((c) => c.fn === "sendPrompt");
  assert(!!sendCall, "clicking Send calls sendPrompt");
  assert(sendCall.text.chatgpt === "hi chatgpt" && sendCall.text.gemini === "hi gemini" && sendCall.text.claude === "", "sends exactly the selected prompt's saved per-AI text, blank field included");
}

async function testPromptLibraryNewAndEditOpenThePopup() {
  console.log("\n== '+ New' and 'Edit' open the standalone prompt editor window, they don't edit inline ==");
  const api = makeApi({
    initialPrompts: [{ id: 5, name: "Kickoff", text: { chatgpt: "x", claude: "", gemini: "" } }]
  });
  const dom = await loadWindow(api);

  click(dom, "btn-prompt-new");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "openPromptEditor" && c.id == null), "'+ New' opens the editor with no id (blank prompt)");

  click(dom, "btn-prompt-edit");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "openPromptEditor" && c.id === 5), "'Edit' opens the editor targeting the currently-selected prompt's id");
}

async function testPromptLibraryDelete() {
  console.log("\n== Prompt Library Delete ==");
  const api = makeApi({
    initialPrompts: [
      { id: 1, name: "System Test", text: { chatgpt: "a", claude: "b", gemini: "c" } },
      { id: 2, name: "Kickoff", text: { chatgpt: "x", claude: "", gemini: "" } }
    ]
  });
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  click(dom, "btn-prompt-delete");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "deletePrompt" && c.id === 1), "Delete removes the currently-selected prompt (the first one, by default)");
  assert(doc.getElementById("prompt-select").options.length === 1, "the dropdown re-renders with one fewer option");
}

async function testPromptLibraryLiveSync() {
  console.log("\n== Prompt Library dropdown updates when the popup editor saves elsewhere ==");
  const api = makeApi({ initialPrompts: [{ id: 1, name: "System Test", text: {} }] });
  const dom = await loadWindow(api);
  const doc = dom.window.document;
  assert(doc.getElementById("prompt-select").options.length === 1, "starts with one saved prompt");

  api.firePromptsChanged([
    { id: 1, name: "System Test", text: {} },
    { id: 2, name: "New Prompt", text: { chatgpt: "hi" } }
  ]);
  assert(doc.getElementById("prompt-select").options.length === 2, "a 'prompts-changed' broadcast (from the popup window saving) re-renders the dropdown without needing a manual refresh");
}

async function main() {
  await testPaneCollapseToggle();
  await testWindowTitlebarCollapse();
  await testHouseRuleStopConfirmation();
  await testRoundtableDropdownOption();
  await testRoundtableBadgeParity();
  await testHouseRuleModeHidesManualControls();
  await testCollapsedPanesMoveToTheirOwnStrip();
  await testAllPanesCollapsedExpandsTranscript();
  await testPromptLibraryDropdownRenders();
  await testPromptLibraryEmptyState();
  await testPromptLibrarySend();
  await testPromptLibraryNewAndEditOpenThePopup();
  await testPromptLibraryDelete();
  await testPromptLibraryLiveSync();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
