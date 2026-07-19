// test/prompt-editor.test.js — runs the REAL prompt-editor.html/prompt-editor.js
// in jsdom with window.api stubbed the way preload.js exposes it. This is the
// standalone popup window for creating/editing one Prompt Library entry;
// test/controls.test.js only covers that the Automation window's dropdown
// *opens* this window (openPromptEditor calls) — this file covers what
// actually happens inside it. Run with: node test/prompt-editor.test.js
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

function makeApi({ prompts } = {}) {
  const calls = [];
  const api = {
    calls,
    getState: async () => ({ ok: true, prompts: prompts || [] }),
    savePrompt: async (id, name, text) => { calls.push({ fn: "savePrompt", id, name, text }); return { ok: true, prompts: prompts || [] }; },
    closePromptEditor: async () => { calls.push({ fn: "closePromptEditor" }); return { ok: true }; }
  };
  return api;
}

async function loadWindow(api, { search = "" } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "prompt-editor.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://localhost/prompt-editor.html${search}` });
  dom.window.api = api;
  const script = fs.readFileSync(path.join(__dirname, "..", "prompt-editor.js"), "utf8");
  dom.window.eval(script);
  await new Promise((r) => setTimeout(r, 20));
  return dom;
}

function click(dom, id) {
  dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

async function testBlankForNewPrompt() {
  console.log("\n== No '?id=' in the URL — blank fields, for creating a new prompt ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  assert(doc.getElementById("name").value === "", "name starts blank");
  assert(doc.getElementById("text-chatgpt").value === "" && doc.getElementById("text-claude").value === "" && doc.getElementById("text-gemini").value === "", "all three per-AI boxes start blank");
}

async function testPopulatesForExistingPrompt() {
  console.log("\n== '?id=<n>' matching a saved prompt — fields populate from it ==");
  const dom = await loadWindow(makeApi({
    prompts: [{ id: 7, name: "Kickoff", text: { chatgpt: "hi chatgpt", claude: "", gemini: "hi gemini" } }]
  }), { search: "?id=7" });
  const doc = dom.window.document;
  assert(doc.getElementById("name").value === "Kickoff", "name is populated from the matching saved prompt");
  assert(doc.getElementById("text-chatgpt").value === "hi chatgpt", "chatgpt's box is populated");
  assert(doc.getElementById("text-claude").value === "", "claude's box correctly stays blank (it was blank when saved)");
  assert(doc.getElementById("text-gemini").value === "hi gemini", "gemini's box is populated");
}

async function testUnknownIdStaysBlank() {
  console.log("\n== '?id=' pointing at a prompt that no longer exists — doesn't crash, just stays blank ==");
  const dom = await loadWindow(makeApi({ prompts: [] }), { search: "?id=999" });
  const doc = dom.window.document;
  assert(doc.getElementById("name").value === "", "name stays blank rather than throwing when the id isn't found");
}

async function testFillAllCopiesIntoAllThreeBoxes() {
  console.log("\n== '→ All' copies the scratch text into every per-AI box, overwriting existing content ==");
  const dom = await loadWindow(makeApi());
  const doc = dom.window.document;
  doc.getElementById("text-claude").value = "will be overwritten";
  doc.getElementById("fill-all-text").value = "same message for everyone";
  click(dom, "btn-fill-all");
  assert(doc.getElementById("text-chatgpt").value === "same message for everyone", "chatgpt's box gets the shared text");
  assert(doc.getElementById("text-claude").value === "same message for everyone", "claude's box gets overwritten with it too");
  assert(doc.getElementById("text-gemini").value === "same message for everyone", "gemini's box gets it as well");
}

async function testSaveCallsSavePromptThenCloses() {
  console.log("\n== Save sends the id/name/per-AI text to savePrompt, then closes the window ==");
  const api = makeApi({ prompts: [{ id: 3, name: "Old Name", text: {} }] });
  const dom = await loadWindow(api, { search: "?id=3" });
  const doc = dom.window.document;
  doc.getElementById("name").value = "New Name";
  doc.getElementById("text-chatgpt").value = "updated text";
  click(dom, "btn-save");
  await new Promise((r) => setTimeout(r, 20));

  const saveCall = api.calls.find((c) => c.fn === "savePrompt");
  assert(!!saveCall, "Save calls savePrompt");
  assert(saveCall.id === 3, "passes the id being edited, so it updates in place rather than creating a duplicate");
  assert(saveCall.name === "New Name" && saveCall.text.chatgpt === "updated text", "passes the current (possibly edited) name and per-AI text");
  assert(api.calls.some((c) => c.fn === "closePromptEditor"), "the window closes itself once the save succeeds");
}

async function testSaveWithNoIdCreatesNew() {
  console.log("\n== Save with no '?id=' passes id:null — a genuinely new prompt, not an update ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  dom.window.document.getElementById("name").value = "Brand New";
  click(dom, "btn-save");
  await new Promise((r) => setTimeout(r, 20));
  const saveCall = api.calls.find((c) => c.fn === "savePrompt");
  assert(saveCall && saveCall.id == null, "id is null/undefined — main.js treats that as create-new, not edit-existing");
}

async function testBlankNameDefaultsToUntitled() {
  console.log("\n== Saving with an empty name still saves something sensible ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  click(dom, "btn-save");
  await new Promise((r) => setTimeout(r, 20));
  const saveCall = api.calls.find((c) => c.fn === "savePrompt");
  assert(saveCall && saveCall.name === "Untitled", `an empty name field is saved as "Untitled" rather than blank (got "${saveCall && saveCall.name}")`);
}

async function testCancelClosesWithoutSaving() {
  console.log("\n== Cancel just closes, no save call at all ==");
  const api = makeApi();
  const dom = await loadWindow(api);
  dom.window.document.getElementById("name").value = "Should not be saved";
  click(dom, "btn-cancel");
  await new Promise((r) => setTimeout(r, 20));
  assert(!api.calls.some((c) => c.fn === "savePrompt"), "Cancel never calls savePrompt");
  assert(api.calls.some((c) => c.fn === "closePromptEditor"), "Cancel does close the window");
}

async function main() {
  await testBlankForNewPrompt();
  await testPopulatesForExistingPrompt();
  await testUnknownIdStaysBlank();
  await testFillAllCopiesIntoAllThreeBoxes();
  await testSaveCallsSavePromptThenCloses();
  await testSaveWithNoIdCreatesNew();
  await testBlankNameDefaultsToUntitled();
  await testCancelClosesWithoutSaving();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
