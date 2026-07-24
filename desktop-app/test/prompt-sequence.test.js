// test/prompt-sequence.test.js — runs the REAL prompt-sequence.html/
// prompt-sequence.js in jsdom with window.api stubbed the way preload.js
// exposes it. This is the standalone popup window for queueing up multiple
// prompts, each targeted at a specific AI (or all), sent one after another
// once its target actually replies. test/run.js covers the real backend
// (sequence:run/sequence:stop/reply-gated advancement); this file covers
// what happens inside the popup itself. Run with: node test/prompt-sequence.test.js
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

function makeApi({ runResult } = {}) {
  const calls = [];
  let sequenceStateCb = null;
  const api = {
    calls,
    fireSequenceState: (payload) => sequenceStateCb && sequenceStateCb(payload),
    runSequence: async (steps) => { calls.push({ fn: "runSequence", steps }); return runResult || { ok: true }; },
    closeSequenceEditor: async () => { calls.push({ fn: "closeSequenceEditor" }); return { ok: true }; },
    onSequenceState: (cb) => { sequenceStateCb = cb; }
  };
  return api;
}

async function loadWindow(api) {
  const html = fs.readFileSync(path.join(__dirname, "..", "prompt-sequence.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/prompt-sequence.html" });
  dom.window.api = api;
  const script = fs.readFileSync(path.join(__dirname, "..", "prompt-sequence.js"), "utf8");
  dom.window.eval(script);
  await new Promise((r) => setTimeout(r, 20));
  return dom;
}

function click(dom, id) {
  dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

async function testStartsWithOneBlankAllStep() {
  console.log("\n== Starts with a single blank 'all' step, ready to fill in ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  const rows = doc.querySelectorAll("#steps .step");
  assert(rows.length === 1, "exactly one step row to start");
  assert(rows[0].querySelector(".step-target").value === "all", "defaults to targeting 'all'");
  assert(rows[0].querySelector(".step-text").value === "", "text starts blank");
  assert(rows[0].querySelector(".num").textContent === "1.", "numbered starting at 1");
}

async function testAddAndRemoveStepsRenumber() {
  console.log("\n== '+ Add Step' adds rows; removing one renumbers the rest ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;

  click(dom, "btn-add-step");
  click(dom, "btn-add-step");
  let rows = doc.querySelectorAll("#steps .step");
  assert(rows.length === 3, "two more clicks add two more rows (3 total)");
  assert(rows[2].querySelector(".num").textContent === "3.", "new rows are numbered in order");

  rows[1].querySelector(".btn-remove").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  rows = doc.querySelectorAll("#steps .step");
  assert(rows.length === 2, "removing the middle row leaves two");
  assert(rows[0].querySelector(".num").textContent === "1." && rows[1].querySelector(".num").textContent === "2.", "remaining rows renumber to stay sequential, no gap left behind");
}

async function testEachStepHasAllThreeSiteOptionsPlusAll() {
  console.log("\n== Each step's target dropdown offers All + each of the three sites ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  const select = doc.querySelector("#steps .step-target");
  const values = Array.from(select.options).map((o) => o.value);
  assert(values.length === 4 && values.includes("all") && values.includes("chatgpt") && values.includes("claude") && values.includes("gemini"), `options are all/chatgpt/claude/gemini (got ${values.join(",")})`);
}

async function testRunCollectsAllStepsWithText() {
  console.log("\n== Run Sequence collects every step's target+text and calls runSequence ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const first = doc.querySelector("#steps .step");
  first.querySelector(".step-target").value = "chatgpt";
  first.querySelector(".step-text").value = "First step text";

  click(dom, "btn-add-step");
  const second = doc.querySelectorAll("#steps .step")[1];
  second.querySelector(".step-target").value = "claude";
  second.querySelector(".step-text").value = "Second step text";

  click(dom, "btn-run");
  await new Promise((r) => setTimeout(r, 20));

  const runCall = api.calls.find((c) => c.fn === "runSequence");
  assert(!!runCall, "clicking Run Sequence calls runSequence");
  assert(runCall.steps.length === 2, "passes both filled-in steps");
  assert(runCall.steps[0].target === "chatgpt" && runCall.steps[0].text === "First step text", "step 1 target/text carried through correctly");
  assert(runCall.steps[1].target === "claude" && runCall.steps[1].text === "Second step text", "step 2 target/text carried through correctly");
}

async function testRunFiltersOutBlankSteps() {
  console.log("\n== Run Sequence drops steps with no text before sending ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  const first = doc.querySelector("#steps .step");
  first.querySelector(".step-text").value = "   "; // whitespace-only
  click(dom, "btn-add-step");
  const second = doc.querySelectorAll("#steps .step")[1];
  second.querySelector(".step-target").value = "gemini";
  second.querySelector(".step-text").value = "Real text";

  click(dom, "btn-run");
  await new Promise((r) => setTimeout(r, 20));

  const runCall = api.calls.find((c) => c.fn === "runSequence");
  assert(!!runCall && runCall.steps.length === 1 && runCall.steps[0].text === "Real text", "the blank/whitespace-only step never reaches runSequence");
}

async function testRunWithNoTextedStepsShowsStatusInstead() {
  console.log("\n== Run Sequence with nothing filled in shows a status message instead of calling the backend ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  click(dom, "btn-run");
  await new Promise((r) => setTimeout(r, 20));
  assert(!api.calls.some((c) => c.fn === "runSequence"), "runSequence is never called when every step is blank");
  assert(doc.getElementById("status").textContent.length > 0, "a status message explains why nothing happened");
}

async function testRunErrorReenablesButton() {
  console.log("\n== A rejected run (e.g. ALREADY_RUNNING) re-enables the Run button and shows the error ==");
  const api = makeApi({ runResult: { ok: false, error: "ALREADY_RUNNING" } });
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  doc.querySelector("#steps .step-text").value = "Some text";
  click(dom, "btn-run");
  await new Promise((r) => setTimeout(r, 20));

  assert(!doc.getElementById("btn-run").disabled, "Run re-enables after a rejected start");
  assert(doc.getElementById("status").textContent.includes("ALREADY_RUNNING"), `status shows the actual error (got "${doc.getElementById("status").textContent}")`);
}

async function testSequenceStateUpdatesStatusAndDisablesRun() {
  console.log("\n== onSequenceState broadcasts drive the status line and the Run button's enabled state ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  const doc = dom.window.document;

  api.fireSequenceState({ active: true, index: 1, total: 3 });
  assert(doc.getElementById("btn-run").disabled, "Run is disabled while a sequence is active");
  assert(doc.getElementById("status").textContent.includes("2 of 3"), `status shows 1-indexed progress (got "${doc.getElementById("status").textContent}")`);

  api.fireSequenceState({ active: false, index: 3, total: 3 });
  assert(!doc.getElementById("btn-run").disabled, "Run re-enables once the sequence finishes");
  assert(doc.getElementById("status").textContent === "Sequence finished.", "status reports completion");
}

async function testCloseButtonCallsCloseSequenceEditor() {
  console.log("\n== Close calls closeSequenceEditor ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  click(dom, "btn-close");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "closeSequenceEditor"), "clicking Close calls closeSequenceEditor");
}

async function main() {
  await testStartsWithOneBlankAllStep();
  await testAddAndRemoveStepsRenumber();
  await testEachStepHasAllThreeSiteOptionsPlusAll();
  await testRunCollectsAllStepsWithText();
  await testRunFiltersOutBlankSteps();
  await testRunWithNoTextedStepsShowsStatusInstead();
  await testRunErrorReenablesButton();
  await testSequenceStateUpdatesStatusAndDisablesRun();
  await testCloseButtonCallsCloseSequenceEditor();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
