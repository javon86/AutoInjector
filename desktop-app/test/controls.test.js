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

function makeApi({ initialPrompts, pickResult, selfTestResult, tunerRunResult, loginSaveResult, loginFillResult } = {}) {
  const calls = [];
  const savedLogins = { chatgpt: [], claude: [], gemini: [] };
  let nextLoginId = 1;
  let windowCollapseCb = null;
  let captureCb = null;
  let houseRuleCb = null;
  let promptsChangedCb = null;
  let logCb = null;
  let tunerStateCb = null;
  let prompts = initialPrompts || [{ id: 1, name: "System Test", text: { chatgpt: "hi chatgpt", claude: "hi claude", gemini: "hi gemini" } }];
  let nextPromptId = prompts.reduce((m, p) => Math.max(m, p.id + 1), 1);
  const routing = { chatgpt: [], claude: [], gemini: [] };
  const noop = async () => ({ ok: true });
  const api = {
    calls,
    fireWindowCollapseChanged: (payload) => windowCollapseCb && windowCollapseCb(payload),
    fireCapture: (turn) => captureCb && captureCb(turn),
    fireHouseRuleState: (hr) => houseRuleCb && houseRuleCb(hr),
    firePromptsChanged: (p) => promptsChangedCb && promptsChangedCb(p),
    fireLog: (entry) => logCb && logCb(entry),
    fireTunerState: (payload) => tunerStateCb && tunerStateCb(payload),
    sendCompose: noop, sendForward: noop, regenerate: noop,
    setRouting: async (source, target, on) => {
      calls.push({ fn: "setRouting", source, target, on });
      if (on) { if (!routing[source].includes(target)) routing[source].push(target); }
      else { routing[source] = routing[source].filter((t) => t !== target); }
      return { ok: true, routing: JSON.parse(JSON.stringify(routing)) };
    },
    pauseAllRouting: noop, stopAllRouting: noop, autoAllRouting: noop,
    setParticipant: noop,
    startHouseRule: async (mode, topic, rounds) => { calls.push({ fn: "startHouseRule", mode, topic, rounds }); return { ok: true, houseRule: { mode, active: true, paused: false, topic, rounds, roundNum: 0, roles: {}, nextSpeaker: null } }; },
    stopHouseRule: async () => { calls.push({ fn: "stopHouseRule" }); return { ok: true, houseRule: { mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null }, global: { routing: { chatgpt: [], claude: [], gemini: [] }, enabled: {}, waiting: {}, meshActive: false, customRole: {} } }; },
    pauseHouseRule: noop, resumeHouseRule: noop, wrapUpBrainstorm: noop,
    setRole: async (site, role) => { calls.push({ fn: "setRole", site, role }); return { ok: true }; },
    setZoom: async (site, factor) => { calls.push({ fn: "setZoom", site, factor }); return { ok: true, factor }; },
    pickSelector: async (site, role) => { calls.push({ fn: "pickSelector", site, role }); return pickResult || { ok: true, selector: `#mock-${site}-${role}`, tag: "div", sample: "sample text" }; },
    clearSelectorOverride: async (site, role) => { calls.push({ fn: "clearSelectorOverride", site, role }); return { ok: true }; },
    runSelfTest: async (site) => { calls.push({ fn: "runSelfTest", site }); return selfTestResult || { ok: true }; },
    runTuner: async () => { calls.push({ fn: "runTuner" }); return tunerRunResult || { ok: true }; },
    openSequenceEditor: async () => { calls.push({ fn: "openSequenceEditor" }); return { ok: true }; },
    clearTranscript: noop, togglePin: noop, reloadSite: noop,
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
    listSavedLogins: async () => { calls.push({ fn: "listSavedLogins" }); return { ok: true, logins: savedLogins }; },
    saveLogin: async (site, label, username, password) => {
      calls.push({ fn: "saveLogin", site, label, username, password });
      if (loginSaveResult) return loginSaveResult;
      savedLogins[site] = [...savedLogins[site], { id: nextLoginId++, label, username }];
      return { ok: true, logins: savedLogins[site] };
    },
    deleteLogin: async (site, id) => {
      calls.push({ fn: "deleteLogin", site, id });
      savedLogins[site] = savedLogins[site].filter((l) => l.id !== id);
      return { ok: true, logins: savedLogins[site] };
    },
    fillLogin: async (site, id) => {
      calls.push({ fn: "fillLogin", site, id });
      return loginFillResult || { ok: true, filled: ["username", "password"], submitted: true };
    },
    getState: async () => ({
      ok: true,
      global: { routing: { chatgpt: [], claude: [], gemini: [] }, enabled: { chatgpt: true, claude: true, gemini: true }, waiting: {}, meshActive: false, customRole: {} },
      houseRule: { mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null },
      captured: { chatgpt: null, claude: null, gemini: null },
      transcript: [],
      log: [],
      logins: savedLogins,
      prompts
    }),
    onCapture: (cb) => { captureCb = cb; }, onSent: () => {}, onSendError: () => {}, onWaitingChanged: () => {},
    onHouseRuleState: (cb) => { houseRuleCb = cb; }, onLog: (cb) => { logCb = cb; },
    onTunerState: (cb) => { tunerStateCb = cb; },
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
  assert(col.classList.contains("state-open"), "starts in the OPEN state");

  const btn = col.querySelector(".collapse-btn");
  assert(!!btn, "each column has its own state-cycle button");

  // Three-state cycle: open -> reduced -> min -> open.
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(col.classList.contains("state-reduced") && !col.classList.contains("state-open"), "first click -> REDUCED (the middle state)");
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(col.classList.contains("state-min") && !col.classList.contains("state-reduced"), "second click -> MINIMIZED");
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(col.classList.contains("state-open") && !col.classList.contains("state-min"), "third click -> back to OPEN (full cycle)");

  const otherCol = dom.window.document.getElementById("col-chatgpt");
  assert(otherCol.classList.contains("state-open"), "cycling claude's pane does NOT change chatgpt's — each is independent");

  // The whole minimized bar is an expand target: clicking the column (not the
  // button) while minimized opens it fully.
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); // -> reduced
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); // -> min
  assert(col.classList.contains("state-min"), "back to minimized for the bar-click test");
  col.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(col.classList.contains("state-open"), "clicking anywhere on the minimized bar opens the pane fully");
}

async function testWindowTitlebarCollapse() {
  console.log("\n== Automation window titlebar collapse ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  click(dom, "btn-collapse-window");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "toggleWindowCollapse" && c.which === "automation"), "clicking the titlebar button calls toggleWindowCollapse('automation')");

  api.fireWindowCollapseChanged({ which: "some-other-window", collapsed: true });
  assert(!dom.window.document.getElementById("wrap").classList.contains("window-collapsed"), "a collapse event for a different window id is ignored here");

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

async function testNoRoundtableDropdownOption() {
  console.log("\n== Roundtable v2 is the always-on baseline now, not a House Rules dropdown option ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  const option = dom.window.document.querySelector('#hr-mode option[value="roundtable"]');
  assert(!option, "hr-mode has no roundtable option — it isn't a stage you start/stop, it's the program's default behavior");

  const debateOption = dom.window.document.querySelector('#hr-mode option[value="debate"]');
  assert(!!debateOption, "the 7 real stage formats (e.g. debate) are still present");
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

async function testManualControlsStayVisibleAndClickableAlways() {
  console.log("\n== Manual Forward/Auto buttons are always visible and always clickable, no matter what a House Rules stage is doing ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const fwdRow = doc.querySelector("#col-claude .fwd-row");
  const autoRow = doc.querySelector("#col-claude .auto-row");
  const isVisible = (elm) => elm && elm.offsetParent !== null || (elm && dom.window.getComputedStyle(elm).display !== "none");
  assert(isVisible(fwdRow) && isVisible(autoRow), "with no House Rule ever run, Forward/Auto rows are visible");

  api.fireHouseRuleState({ mode: "debate", active: true, paused: false, topic: "x", rounds: 2, roundNum: 1, roles: {}, nextSpeaker: null });
  assert(isVisible(fwdRow) && isVisible(autoRow), "still visible while a stage (debate) is actively running");
  assert(!doc.getElementById("ai-row").classList.contains("hr-active"), "the old hr-active hiding class is gone entirely — nothing toggles it anymore");

  const autoBtn = autoRow.querySelector('.auto-toggle[data-auto-target="chatgpt"]');
  autoBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "setRouting" && c.source === "claude" && c.target === "chatgpt"), "the buttons stay genuinely clickable during a stage — clicking Auto still calls setRouting");

  api.fireHouseRuleState({ mode: null, active: false, paused: false, topic: "", rounds: 0, roundNum: 0, roles: {}, nextSpeaker: null });
  assert(isVisible(fwdRow) && isVisible(autoRow), "still visible once the stage is stopped and tag-routing resumes underneath");
}

async function testAutoBothButton() {
  console.log("\n== The combined 'Both' Auto toggle turns both individual routes on/off together ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const bothBtn = doc.querySelector('#col-claude .auto-toggle[data-auto-target="both"]');
  assert(!!bothBtn, "each column has a combined Both auto-toggle button");
  assert(!bothBtn.classList.contains("on"), "starts off — no routing set up yet");

  bothBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const onCalls = api.calls.filter((c) => c.fn === "setRouting" && c.source === "claude" && c.on === true);
  assert(onCalls.length === 2 && onCalls.some((c) => c.target === "chatgpt") && onCalls.some((c) => c.target === "gemini"), "one click turns BOTH individual routes on, in a single action");
  assert(bothBtn.classList.contains("on"), "the Both button itself lights up once both individual routes are on");

  const singleBtn = doc.querySelector('#col-claude .auto-toggle[data-auto-target="chatgpt"]');
  assert(singleBtn.classList.contains("on"), "the individual →ChatGPT toggle also reflects as on");

  bothBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const offCalls = api.calls.filter((c) => c.fn === "setRouting" && c.source === "claude" && c.on === false);
  assert(offCalls.length === 2, "clicking it again while both are on turns both routes off together");
  assert(!bothBtn.classList.contains("on"), "Both button turns back off");
}

async function testZoomControls() {
  console.log("\n== Per-pane zoom buttons call setZoom and update the on-screen percentage label ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const zoomLabel = doc.getElementById("zoom-level-gemini");
  assert(!!zoomLabel && zoomLabel.textContent === "100%", "starts at 100%");

  const buttons = doc.querySelectorAll("#col-gemini .zoom-btn");
  assert(buttons.length === 2, "each column has a zoom-out and a zoom-in button");
  const [zoomOutBtn, zoomInBtn] = buttons;

  zoomOutBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "setZoom" && c.site === "gemini" && c.factor < 1), "zoom-out calls setZoom with a factor below 1");
  assert(zoomLabel.textContent === "90%", `label reflects the new factor (got "${zoomLabel.textContent}")`);

  zoomInBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  zoomInBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(zoomLabel.textContent === "110%", `label updates back up (got "${zoomLabel.textContent}")`);
}

async function testSelectorPickMenuToggle() {
  console.log("\n== Selector picker: the 🎯 menu is collapsed by default and toggles open/closed ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  const menu = doc.getElementById("pick-menu-claude");
  assert(menu.classList.contains("collapsed"), "starts collapsed");

  const pickBtn = doc.querySelector("#col-claude .pick-btn");
  assert(!!pickBtn, "each column has its own 🎯 pick button");
  pickBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!menu.classList.contains("collapsed"), "clicking it opens the menu");
  pickBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(menu.classList.contains("collapsed"), "clicking it again closes the menu");
}

async function testSelectorPickSuccess() {
  console.log("\n== Selector picker: a successful pick calls pickSelector with the right site/role and shows the result inline ==");
  const api = makeApi({ pickResult: { ok: true, selector: '[data-testid="composer"]', tag: "div", sample: "Hello world" } });
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const menu = doc.getElementById("pick-menu-claude");
  const inputBtn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent === "Pick Input");
  assert(!!inputBtn, "menu has a Pick Input button");
  inputBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const pickCall = api.calls.find((c) => c.fn === "pickSelector");
  assert(!!pickCall && pickCall.site === "claude" && pickCall.role === "input", "clicking Pick Input calls pickSelector('claude', 'input')");

  const statusEl = doc.getElementById("pick-status-claude");
  assert(statusEl.textContent.includes('[data-testid="composer"]'), "the picked selector is shown inline as confirmation");
  assert(statusEl.textContent.includes("Hello world"), "the sample text is shown too -- no separate test panel needed");
}

async function testSelectorPickFailure() {
  console.log("\n== Selector picker: a failed/timed-out pick reports the error instead of pretending success ==");
  const api = makeApi({ pickResult: { ok: false, error: "TIMEOUT" } });
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const menu = doc.getElementById("pick-menu-gemini");
  const sendBtn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent === "Pick Send");
  sendBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const statusEl = doc.getElementById("pick-status-gemini");
  assert(statusEl.textContent.includes("TIMEOUT"), `the failure reason is shown, not silently swallowed (got "${statusEl.textContent}")`);
}

async function testClearOverridesButton() {
  console.log("\n== Selector picker: Clear Overrides clears all three roles for that site ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const menu = doc.getElementById("pick-menu-chatgpt");
  const clearBtn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent === "Clear Overrides");
  clearBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const clearCalls = api.calls.filter((c) => c.fn === "clearSelectorOverride" && c.site === "chatgpt");
  assert(clearCalls.length === 3 && ["input", "send", "assistant"].every((role) => clearCalls.some((c) => c.role === role)), "Clear Overrides clears input, send, and assistant for that site");
}

function findByText(nodes, text) {
  return Array.from(nodes).find((n) => n.textContent === text);
}

async function testSavedLoginsAddAndFill() {
  console.log("\n== Saved logins: adding one shows it in the list, clicking it calls fillLogin -- never auto-triggered ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const menu = doc.getElementById("login-menu-claude");
  assert(!!menu, "each column has its own login menu");
  assert(doc.getElementById("login-list-claude").textContent.includes("No saved logins yet"), "starts with no saved logins");
  assert(!api.calls.some((c) => c.fn === "fillLogin"), "loading the window never calls fillLogin on its own -- purely manual");

  const addToggle = findByText(menu.querySelectorAll("button"), "+ Add Login");
  addToggle.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!doc.getElementById("login-add-form-claude").classList.contains("collapsed"), "clicking + Add Login reveals the form");

  doc.getElementById("login-label-claude").value = "Personal";
  doc.getElementById("login-username-claude").value = "me@example.com";
  doc.getElementById("login-password-claude").value = "hunter2";
  const saveBtn = findByText(menu.querySelectorAll("button"), "Save Login");
  saveBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const saveCall = api.calls.find((c) => c.fn === "saveLogin");
  assert(!!saveCall && saveCall.site === "claude" && saveCall.label === "Personal" && saveCall.username === "me@example.com" && saveCall.password === "hunter2", "Save Login sends the real label/username/password for the right site");
  assert(doc.getElementById("login-add-form-claude").classList.contains("collapsed"), "the add form collapses again after a successful save");
  assert(doc.getElementById("login-label-claude").value === "" && doc.getElementById("login-password-claude").value === "", "the form fields (including the password) are cleared after saving, not left sitting in the DOM");

  const list = doc.getElementById("login-list-claude");
  const fillBtn = Array.from(list.querySelectorAll("button")).find((b) => b.textContent.includes("Personal") && b.textContent.includes("me@example.com"));
  assert(!!fillBtn, "the newly saved login appears in the list, labeled with its name and username");

  fillBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const fillCall = api.calls.find((c) => c.fn === "fillLogin");
  assert(!!fillCall && fillCall.site === "claude" && fillCall.id === 1, "clicking the saved login calls fillLogin with that exact site+id -- this is the ONLY thing that ever triggers a fill");
  assert(doc.getElementById("login-status-claude").textContent.includes("Filled") || doc.getElementById("login-status-claude").textContent.includes("filled"), "the login status line reports what happened");
}

async function testSavedLoginsDeleteAndSaveFailure() {
  console.log("\n== Saved logins: delete removes it from the list, and a rejected save shows the specific reason ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const menu = doc.getElementById("login-menu-gemini");
  findByText(menu.querySelectorAll("button"), "+ Add Login").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  doc.getElementById("login-label-gemini").value = "Work";
  doc.getElementById("login-username-gemini").value = "work@example.com";
  doc.getElementById("login-password-gemini").value = "correcthorse";
  findByText(menu.querySelectorAll("button"), "Save Login").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const list = doc.getElementById("login-list-gemini");
  assert(list.textContent.includes("Work"), "the saved login shows up first");
  const deleteBtn = Array.from(list.querySelectorAll("button")).find((b) => b.textContent === "✕");
  deleteBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert(api.calls.some((c) => c.fn === "deleteLogin" && c.site === "gemini"), "the ✕ button calls deleteLogin for the right site");
  assert(doc.getElementById("login-list-gemini").textContent.includes("No saved logins yet"), "the list reflects the deletion immediately");

  // a rejected save (e.g. no OS keychain available) shows the specific reason, not a generic error
  const failApi = makeApi({ loginSaveResult: { ok: false, error: "ENCRYPTION_UNAVAILABLE" } });
  const failDom = await loadWindow(failApi);
  const failDoc = failDom.window.document;
  const failMenu = failDoc.getElementById("login-menu-chatgpt");
  findByText(failMenu.querySelectorAll("button"), "+ Add Login").dispatchEvent(new failDom.window.Event("click", { bubbles: true }));
  failDoc.getElementById("login-label-chatgpt").value = "Test";
  failDoc.getElementById("login-username-chatgpt").value = "a@b.com";
  failDoc.getElementById("login-password-chatgpt").value = "x";
  findByText(failMenu.querySelectorAll("button"), "Save Login").dispatchEvent(new failDom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(failDoc.getElementById("login-status-chatgpt").textContent.toLowerCase().includes("secure credential storage"), `the specific failure reason is shown, not a bare error code (got "${failDoc.getElementById("login-status-chatgpt").textContent}")`);
}

async function testConnectivityTestButtonSuccess() {
  console.log("\n== Connectivity Test: a pass calls runSelfTest and lights the indicator green ==");
  const api = makeApi({ selfTestResult: { ok: true } });
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const led = doc.getElementById("test-led-claude");
  assert(!led.classList.contains("ok") && !led.classList.contains("fail"), "starts with no result yet");

  const menu = doc.getElementById("pick-menu-claude");
  const testBtn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent === "🧪 Test");
  assert(!!testBtn, "each column's picker menu has a Test button");
  testBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(led.classList.contains("pending"), "the indicator shows pending immediately, before the result comes back");
  await new Promise((r) => setTimeout(r, 20));

  assert(api.calls.some((c) => c.fn === "runSelfTest" && c.site === "claude"), "clicking Test calls runSelfTest('claude')");
  assert(led.classList.contains("ok") && !led.classList.contains("pending"), "a passing result lights the indicator green");
  const statusEl = doc.getElementById("pick-status-claude");
  assert(statusEl.textContent.includes("hooked up correctly"), `the status line confirms success in plain language (got "${statusEl.textContent}")`);
}

async function testTunerButton() {
  console.log("\n== The Tuner button: click calls runTuner, shows live progress, and reports a final summary ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const btn = doc.getElementById("btn-run-tuner");
  assert(!!btn, "the Global panel has a Run Tuner button");
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "runTuner"), "clicking it calls runTuner");
  assert(btn.disabled, "the button disables itself while a run is in flight, so it can't be double-clicked");

  api.fireTunerState({ phase: "site", site: "claude" });
  assert(doc.getElementById("tuner-status").textContent.includes("Claude"), `live progress names the site currently being checked (got "${doc.getElementById("tuner-status").textContent}")`);

  api.fireTunerState({ phase: "leg", leg: "chatgpt->claude" });
  assert(doc.getElementById("tuner-status").textContent.includes("ChatGPT") && doc.getElementById("tuner-status").textContent.includes("Claude"), `live progress names both ends of the relay leg currently being checked (got "${doc.getElementById("tuner-status").textContent}")`);

  api.fireTunerState({
    phase: "done",
    sites: { chatgpt: { ok: true }, claude: { ok: true }, gemini: { ok: true } },
    legs: { "chatgpt->claude": { ok: true, leg: "chatgpt->claude" }, "claude->chatgpt": { ok: true, leg: "claude->chatgpt" } },
    summary: { sitesOk: 3, sitesTotal: 3, legsOk: 2, legsTotal: 2 }
  });
  assert(!btn.disabled, "the button re-enables itself once the run finishes");
  assert(doc.getElementById("tuner-status").textContent.includes("3/3") && doc.getElementById("tuner-status").textContent.includes("2/2"), `the final summary reports the actual pass counts (got "${doc.getElementById("tuner-status").textContent}")`);
  assert(doc.getElementById("status").textContent.includes("every site and every relay pair is working"), "a fully clean run says so plainly in the main status line, not just the small progress line");
}

async function testTunerButtonReportsFailures() {
  console.log("\n== The Tuner button: a run with problems names exactly what failed, not just 'something went wrong' ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  doc.getElementById("btn-run-tuner").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  api.fireTunerState({
    phase: "done",
    sites: { chatgpt: { ok: true }, claude: { ok: false, stage: "reply", error: "TIMEOUT" }, gemini: { ok: true } },
    legs: { "chatgpt->claude": { ok: false, leg: "chatgpt->claude", stage: "relay", error: "TIMEOUT" }, "claude->chatgpt": { ok: true, leg: "claude->chatgpt" } },
    summary: { sitesOk: 2, sitesTotal: 3, legsOk: 1, legsTotal: 2 }
  });

  const statusText = doc.getElementById("status").textContent;
  assert(statusText.includes("Claude") && statusText.includes("TIMEOUT"), `the broken site is named specifically, not just counted (got "${statusText}")`);
  assert(statusText.includes("ChatGPT") && statusText.includes("relay"), `the broken relay leg is named specifically, with its failure stage, not just counted (got "${statusText}")`);
}

async function testActivityLogShowsPickAndTestDetail() {
  console.log("\n== Activity Log renders the rich pick/test detail (role, selector, sample, token, what was actually captured), not just the bare event name ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;
  const box = doc.getElementById("activity-log");

  api.fireLog({ ts: Date.now(), kind: "selector-pick-started", detail: { site: "claude", role: "assistant" } });
  let lastLine = box.lastChild.textContent;
  assert(lastLine.includes("role=assistant"), `a pick-started entry shows which role was requested (got "${lastLine}")`);

  api.fireLog({ ts: Date.now(), kind: "selector-picked", detail: { site: "claude", role: "assistant", selector: "div.reply-body", tag: "div", sample: "AUTOINJ-4F7K2Q" } });
  lastLine = box.lastChild.textContent;
  assert(lastLine.includes("div.reply-body") && lastLine.includes("AUTOINJ-4F7K2Q"), `a successful pick shows the selector AND the sample text it actually captured (got "${lastLine}")`);

  api.fireLog({ ts: Date.now(), kind: "selftest-error", detail: { site: "gemini", token: "AUTOINJ-XYZ123", error: "REPLY_MISMATCH", capturedText: "Sure, happy to help!" } });
  lastLine = box.lastChild.textContent;
  assert(lastLine.includes("AUTOINJ-XYZ123") && lastLine.includes("REPLY_MISMATCH") && lastLine.includes("Sure, happy to help!"), `a failed test shows the token, the error, AND what was actually captured instead (got "${lastLine}")`);
  assert(box.lastChild.className.includes("err"), "an error-kind entry is styled distinctly as an error line");
}

async function testConnectivityTestButtonFailure() {
  console.log("\n== Connectivity Test: a failure calls out the specific reason and lights the indicator red ==");
  const api = makeApi({ selfTestResult: { ok: false, stage: "reply", error: "REPLY_MISMATCH" } });
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const menu = doc.getElementById("pick-menu-gemini");
  const testBtn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent === "🧪 Test");
  testBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const led = doc.getElementById("test-led-gemini");
  assert(led.classList.contains("fail") && !led.classList.contains("pending"), "a failing result lights the indicator red");
  const statusEl = doc.getElementById("pick-status-gemini");
  assert(statusEl.textContent.includes("not with what was asked"), `the mismatch reason is spelled out, not just a generic failure (got "${statusEl.textContent}")`);
}

async function testConnectivityTestButtonDistinguishesTooBroadAndEcho() {
  console.log("\n== Connectivity Test: SELECTOR_TOO_BROAD and REPLY_ECHO each get their own distinct, actionable explanation ==");

  const broadApi = makeApi({ selfTestResult: { ok: false, stage: "reply", error: "SELECTOR_TOO_BROAD", text: "prompt+reply mixed together" } });
  let dom = await loadWindow(broadApi);
  let doc = dom.window.document;
  let testBtn = Array.from(doc.getElementById("pick-menu-gemini").querySelectorAll("button")).find((b) => b.textContent === "🧪 Test");
  testBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  let statusEl = doc.getElementById("pick-status-gemini");
  assert(statusEl.textContent.includes("too broad"), `SELECTOR_TOO_BROAD gets its own distinct explanation, not the generic mismatch text (got "${statusEl.textContent}")`);

  const echoApi = makeApi({ selfTestResult: { ok: false, stage: "reply", error: "REPLY_ECHO", text: "the sent prompt again" } });
  dom = await loadWindow(echoApi);
  doc = dom.window.document;
  testBtn = Array.from(doc.getElementById("pick-menu-gemini").querySelectorAll("button")).find((b) => b.textContent === "🧪 Test");
  testBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  statusEl = doc.getElementById("pick-status-gemini");
  assert(statusEl.textContent.includes("echo"), `REPLY_ECHO gets its own distinct explanation too (got "${statusEl.textContent}")`);
}

async function testSelectorPickValidationRejections() {
  console.log("\n== Selector picker: each post-pick validation rejection shows its own specific, actionable reason ==");

  const cases = [
    { error: "NOT_FOUND", expect: "doesn't actually match" },
    { error: "NOT_VISIBLE", expect: "hidden or zero-size" },
    { error: "WRONG_ELEMENT_TYPE", expect: "doesn't look like" },
    { error: "LOOKS_LIKE_ECHO", expect: "last message sent" }
  ];
  for (const { error, expect } of cases) {
    const api = makeApi({ pickResult: { ok: false, error } });
    const dom = await loadWindow(api);
    const doc = dom.window.document;
    const menu = doc.getElementById("pick-menu-claude");
    const inputBtn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent === "Pick Input");
    inputBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const statusEl = doc.getElementById("pick-status-claude");
    assert(statusEl.textContent.includes(expect), `${error} shows its own specific reason (got "${statusEl.textContent}")`);
  }
}

async function testUserPanelMergedAndNeverCollapses() {
  console.log("\n== User Panel: Compose + Participants + Send + Attach + Roles + Sequence are all one panel that never collapses ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;

  const panel = doc.getElementById("col-userpanel");
  assert(!!panel, "the merged User Panel exists");
  assert(panel.contains(doc.getElementById("composer-text")), "Compose lives inside it");
  assert(panel.contains(doc.getElementById("p-chatgpt")) && panel.contains(doc.getElementById("p-claude")) && panel.contains(doc.getElementById("p-gemini")), "the participant checkboxes live inside it too");
  assert(panel.contains(doc.getElementById("btn-attach-document")), "Attach Document lives inside it");
  assert(panel.contains(doc.getElementById("btn-open-roles")), "the Roles trigger lives inside it");
  assert(panel.contains(doc.getElementById("btn-open-sequence")), "Prompt Sequence's trigger now lives inside it too, not in House Rules");
  assert(!panel.querySelector(".collapse-btn"), "it has no collapse button of its own -- unlike Global/House Rules/Prompt Library, it never minimizes");

  // Send + Active is a real two-column grid: SEND / ACTIVE headers, then
  // one row per AI (send button next to that AI's own checkbox, row-
  // aligned) in ChatGPT/Claude/Gemini order, then → All on its own row.
  const grid = doc.getElementById("send-active-grid");
  const headers = Array.from(grid.querySelectorAll("p.zone-label")).map((p) => p.textContent);
  assert(JSON.stringify(headers) === JSON.stringify(["Send", "Active"]), `the grid's own Send/Active column headers are present, in order (got ${JSON.stringify(headers)})`);

  const children = Array.from(grid.children).filter((c) => c.tagName !== "P");
  assert(children.length === 7, `3 AI rows (button+checkbox) plus the → All button = 7 grid cells after the two headers (got ${children.length})`);
  for (let i = 0; i < 6; i += 2) {
    const site = ["chatgpt", "claude", "gemini"][i / 2];
    assert(children[i].tagName === "BUTTON" && children[i].textContent.includes(SITE_LABELS_FOR_TEST[site]), `row ${i / 2}: ${site}'s send button is in the Send column`);
    assert(children[i + 1].id === `p-${site}`, `row ${i / 2}: ${site}'s own checkbox is row-aligned right next to it, in the Active column (got id="${children[i + 1].id}")`);
  }
  assert(children[6].tagName === "BUTTON" && children[6].textContent.trim() === "→ All", "→ All is its own final row, spanning just the Send column (no Active checkbox for it)");
}
const SITE_LABELS_FOR_TEST = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

async function testMessagesToUserFeed() {
  console.log("\n== User Panel: [TO: USER] replies collect into a live Messages feed + badge, not just the Transcript stream ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  assert(doc.getElementById("messages-badge").textContent === "0", "starts at zero");
  assert(doc.getElementById("messages-badge").hasAttribute("data-zero"), "the zero state is visually hidden via the data-zero attribute");
  assert(doc.getElementById("messages-feed").children.length === 0, "feed starts empty");

  // A reply addressed to another AI (not the user) must NOT show up here.
  api.fireCapture({ id: 1, site: "chatgpt", label: "ChatGPT", text: "Handing this to Claude", roundtableTag: "CLAUDE", ts: Date.now(), pinned: false });
  await new Promise((r) => setTimeout(r, 20));
  assert(doc.getElementById("messages-badge").textContent === "0", "a reply tagged for another AI doesn't count as a message to the user");

  // A reply explicitly [TO: USER] (or the documented no-tag fallback --
  // both carry the same roundtableTag value) does.
  api.fireCapture({ id: 2, site: "claude", label: "Claude", text: "Here's the summary you asked for.", roundtableTag: "USER", ts: Date.now(), pinned: false });
  await new Promise((r) => setTimeout(r, 20));
  assert(doc.getElementById("messages-badge").textContent === "1", "a [TO: USER] reply increments the badge");
  let feedRows = doc.querySelectorAll("#messages-feed .feed-row");
  assert(feedRows.length === 1 && feedRows[0].classList.contains("claude"), "it shows up inline in the feed, color-coded by site");
  assert(feedRows[0].querySelector(".snippet").textContent.includes("summary you asked for"), "the inline row shows the actual message text");

  feedRows[0].dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(doc.getElementById("messages-popup").classList.contains("open"), "clicking a feed row opens the full Messages popup");
  assert(doc.querySelectorAll("#messages-popup-body .msg-turn").length === 1, "the popup lists the same message");
  doc.getElementById("btn-close-messages").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!doc.getElementById("messages-popup").classList.contains("open"), "the ✕ button closes it");

  // Only the 3 most recent show inline; the popup shows every one, newest first.
  for (let i = 3; i <= 6; i++) {
    api.fireCapture({ id: i, site: "gemini", label: "Gemini", text: `Message number ${i}`, roundtableTag: "USER", ts: Date.now(), pinned: false });
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 20));
  assert(doc.getElementById("messages-badge").textContent === "5", `badge tracks the real total (got ${doc.getElementById("messages-badge").textContent})`);
  feedRows = doc.querySelectorAll("#messages-feed .feed-row");
  assert(feedRows.length === 3, "the inline feed caps at the 3 most recent, not all 5");
  assert(feedRows[0].querySelector(".snippet").textContent.includes("Message number 6"), "the newest one is shown first inline");
  assert(doc.querySelectorAll("#messages-popup-body .msg-turn").length === 5, "the popup itself lists every one of them, not just the recent 3");
}

async function testCollapsibleYellowPanels() {
  console.log("\n== Global / House Rules / Prompt Library each collapse to a tab in #top-tab-strip, freeing their row's space for the AI panes ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;

  assert(doc.getElementById("top-tab-strip").children.length === 0, "no tabs by default -- nothing collapsed");
  assert(!doc.getElementById("col-global").classList.contains("hidden-collapsed"), "Global starts expanded");

  click(dom, "btn-collapse-global");
  assert(doc.getElementById("col-global").classList.contains("hidden-collapsed"), "collapsing Global hides the real panel");
  const tab = doc.getElementById("tab-global");
  assert(!!tab, "a tab for it appears in the top strip");
  assert(tab.textContent.includes("Global"), "the tab is labeled");

  click(dom, "btn-collapse-houserules");
  click(dom, "btn-collapse-prompts");
  assert(doc.getElementById("top-tab-strip").children.length === 3, "all three collapse independently, each getting its own tab");
  assert(doc.getElementById("col-houserules").classList.contains("hidden-collapsed") && doc.getElementById("col-prompts").classList.contains("hidden-collapsed"), "House Rules and Prompt Library are both hidden too");

  tab.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert(!doc.getElementById("col-global").classList.contains("hidden-collapsed"), "clicking the tab restores the panel");
  assert(!doc.getElementById("tab-global"), "...and removes its own tab");
  assert(doc.getElementById("top-tab-strip").children.length === 2, "the other two tabs are unaffected");
}

async function testRoleAssignmentPanel() {
  console.log("\n== Role Assignment popup: open/close, presets, Apply, Clear ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const overlay = doc.getElementById("roles-popup");
  assert(!overlay.classList.contains("open"), "starts closed");

  click(dom, "btn-open-roles");
  assert(overlay.classList.contains("open"), "the 🎭 Roles button in the User Panel opens it");

  const claudeInput = doc.getElementById("role-claude");
  assert(!!claudeInput, "each site gets its own role input, inside the popup");
  const claudeRow = claudeInput.closest(".roles-popup-row");
  const claudePreset = claudeRow.querySelector("select");
  assert(!!claudePreset, "each row also has a preset dropdown");
  const presetOptions = Array.from(claudePreset.options).map((o) => o.textContent);
  assert(presetOptions.includes("Project Manager") && presetOptions.includes("Detective") && presetOptions.includes("Custom…"), `presets include general-purpose roles plus a Custom option (got ${JSON.stringify(presetOptions)})`);

  // Picking a preset fills the input; Apply is still the one thing that
  // actually commits it -- selecting a preset must not silently send
  // anything on its own.
  claudePreset.value = "Detective";
  claudePreset.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert(claudeInput.value === "Detective", "selecting a preset fills the free-text input");
  assert(!api.calls.some((c) => c.fn === "setRole"), "picking a preset alone doesn't call setRole yet");

  const applyBtn = claudeRow.querySelector("button");
  applyBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "setRole" && c.site === "claude" && c.role === "Detective"), "Apply calls setRole with the preset that was picked");
  assert(doc.getElementById("role-current-claude").textContent === "current: Detective", "the 'current' label updates");

  // Custom free text still works exactly as before, independent of presets.
  claudeInput.value = "Skeptical Engineer";
  applyBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "setRole" && c.site === "claude" && c.role === "Skeptical Engineer"), "Apply also calls setRole with typed custom text");
  assert(doc.getElementById("role-current-claude").textContent === "current: Skeptical Engineer", "the 'current' label reflects the custom text");

  const clearBtn = claudeRow.querySelectorAll("button")[1];
  clearBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "setRole" && c.site === "claude" && c.role === ""), "Clear calls setRole with an empty string");
  assert(claudeInput.value === "", "the input itself is cleared too");
  assert(claudePreset.value === "", "the preset dropdown resets to '— none —' too");
  assert(doc.getElementById("role-current-claude").textContent === "", "the 'current' label clears");

  click(dom, "btn-close-roles");
  assert(!overlay.classList.contains("open"), "the ✕ button closes the popup");
}

async function testOpenSequenceEditorButton() {
  console.log("\n== The Prompt Sequence trigger button opens the sequence popup ==");
  const api = makeApi();
  const dom = await loadWindow(api);

  click(dom, "btn-open-sequence");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "openSequenceEditor"), "clicking 🧵 Prompt Sequence calls openSequenceEditor");
}

async function testMainRowCollapse() {
  console.log("\n== The Transcript/Activity Log panel can be collapsed to free up vertical space ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  const mainRow = doc.getElementById("main-row");

  assert(!mainRow.classList.contains("collapsed"), "starts expanded");

  click(dom, "btn-main-row-collapse");
  assert(mainRow.classList.contains("collapsed"), "clicking the collapse button on the Transcript header collapses the whole panel");

  click(dom, "btn-main-row-collapse");
  assert(!mainRow.classList.contains("collapsed"), "clicking again expands it back");
}

async function testCollapsedPanesMoveToTheirOwnStrip() {
  console.log("\n== A pane's state never changes its position — providers keep a fixed order (AI-UI-003/006) ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  const strip = doc.getElementById("expanded-strip");
  const orderOf = () => Array.from(strip.querySelectorAll(".ai-col")).map((c) => c.id).join(",");
  const FIXED = "col-chatgpt,col-claude,col-gemini";

  assert(orderOf() === FIXED, "panes start in fixed provider order in the side-by-side strip");

  const claudeCol = doc.getElementById("col-claude");
  const btn = claudeCol.querySelector(".collapse-btn");

  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); // -> reduced
  assert(strip.contains(claudeCol) && orderOf() === FIXED, "reducing claude keeps it in the same strip and position");
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); // -> min
  assert(strip.contains(claudeCol) && orderOf() === FIXED, "minimizing claude keeps it in place — order never changes");
  btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); // -> open
  assert(strip.contains(claudeCol) && orderOf() === FIXED, "reopening claude keeps it in place — order still fixed");

  assert(doc.getElementById("col-chatgpt").classList.contains("state-open"), "the other panes are unaffected by claude's state changes");
}

async function testAllPanesCollapsedExpandsTranscript() {
  console.log("\n== Collapsing every AI pane hands its space to the Transcript/Log panel ==");
  const dom = await loadWindow(makeApi());
  const wrap = dom.window.document.getElementById("wrap");

  const btnFor = (site) => dom.window.document.getElementById(`col-${site}`).querySelector(".collapse-btn");
  const click = (b) => b.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  const minimize = (site) => { const b = btnFor(site); click(b); click(b); }; // open -> reduced -> min
  assert(!wrap.classList.contains("all-collapsed"), "starts open — no extra space handed over yet");

  minimize("claude");
  assert(!wrap.classList.contains("all-collapsed"), "only one of three minimized — not enough to hand over space yet");

  minimize("chatgpt");
  minimize("gemini");
  assert(wrap.classList.contains("all-collapsed"), "all three minimized — Conversation/Log panel grows into the freed space");

  click(btnFor("claude")); // min -> open
  assert(!wrap.classList.contains("all-collapsed"), "opening just one pane again gives the space back");
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
  await testNoRoundtableDropdownOption();
  await testRoundtableBadgeParity();
  await testManualControlsStayVisibleAndClickableAlways();
  await testAutoBothButton();
  await testZoomControls();
  await testSelectorPickMenuToggle();
  await testSelectorPickSuccess();
  await testSelectorPickFailure();
  await testSelectorPickValidationRejections();
  await testClearOverridesButton();
  await testSavedLoginsAddAndFill();
  await testSavedLoginsDeleteAndSaveFailure();
  await testConnectivityTestButtonSuccess();
  await testTunerButton();
  await testTunerButtonReportsFailures();
  await testConnectivityTestButtonFailure();
  await testConnectivityTestButtonDistinguishesTooBroadAndEcho();
  await testActivityLogShowsPickAndTestDetail();
  await testUserPanelMergedAndNeverCollapses();
  await testMessagesToUserFeed();
  await testCollapsibleYellowPanels();
  await testRoleAssignmentPanel();
  await testOpenSequenceEditorButton();
  await testMainRowCollapse();
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
