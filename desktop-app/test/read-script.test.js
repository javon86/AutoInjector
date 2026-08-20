// test/read-script.test.js — the injected "read the latest assistant reply"
// script, run against fake chat DOMs in jsdom. Guards the selector priority so
// a broad, user-inclusive selector can't make the app read the user's own
// message back as the reply. Run: node test/read-script.test.js
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { buildReadScript } = require("../automation");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function run(html, site = "claude") {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: "outside-only" });
  // Run the injected script in the jsdom context, where `document` is a global.
  return vm.runInContext(buildReadScript(site), dom.getInternalVMContext());
}

console.log("\n== Claude: reads the assistant reply, never a later user row ==");
{
  // The assistant reply (standard-markdown) is a HIGHER-priority selector than
  // the broad [data-testid=chat-message], which also matches the user's row —
  // and the user's row is LAST in the DOM here.
  const r = run(`
    <div data-testid="chat-message"><div class="standard-markdown">ASSISTANT REPLY</div></div>
    <div data-testid="chat-message">USER TYPED THIS</div>
  `);
  assert(r.ok && /ASSISTANT REPLY/.test(r.text), "reads the assistant reply text");
  assert(!/USER TYPED THIS/.test(r.text), "does NOT read the later user message row");
}

console.log("\n== takes the MOST RECENT assistant message when several ==");
{
  const r = run(`
    <div class="standard-markdown">first answer</div>
    <div class="standard-markdown">latest answer</div>
  `);
  assert(/latest answer/.test(r.text) && !/first answer/.test(r.text), "the newest reply wins");
}

console.log("\n== falls back through the priority list ==");
{
  // No standard-markdown; the next specific selector (font-claude-message) is used.
  const r = run(`
    <div data-testid="chat-message"><div class="font-claude-message">fallback reply</div></div>
    <div data-testid="chat-message">user text</div>
  `);
  assert(/fallback reply/.test(r.text) && !/user text/.test(r.text), "uses the next assistant-specific selector, not the user row");
}

console.log("\n== nothing assistant-ish -> empty, no crash ==");
{
  const r = run(`<div>just some page chrome</div>`);
  assert(r.ok && r.text === "", "returns empty text safely");
}

console.log("\n== ChatGPT / Gemini read their assistant messages ==");
{
  const g = run(`<div data-message-author-role="assistant">gpt answer</div>`, "chatgpt");
  assert(/gpt answer/.test(g.text), "chatgpt: reads the assistant-role message");
  const m = run(`<div class="model-response-text">gemini answer</div>`, "gemini");
  assert(/gemini answer/.test(m.text), "gemini: reads the model-response text");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
