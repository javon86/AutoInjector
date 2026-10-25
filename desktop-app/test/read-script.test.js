// test/read-script.test.js — the injected "read the latest assistant reply"
// script, run against fake chat DOMs in jsdom. Guards the selector priority so
// a broad, user-inclusive selector can't make the app read the user's own
// message back as the reply. Run: node test/read-script.test.js
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { buildReadScript, buildSendScript } = require("../automation");

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

console.log("\n== TR-17: the reply-block count isn't inflated by nested wrappers ==");
{
  const reply = (s) => `<div data-response-index="1"><div class="model-response-text"><message-content><div class="markdown">${s}</div></message-content></div></div>`;
  const r = run(reply("one") + reply("two"), "gemini");
  assert(r.count === 2, `two Gemini replies (each matched by 3 nested selectors) count as 2, not 6 (got ${r.count})`);
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

// The generating signal drives completion — a reply is "done" only once the site
// stops streaming (Stop button gone / Send button back). jsdom reports zero-size
// rects by default, so stub getBoundingClientRect to make buttons "visible".
function runGen(html, site = "chatgpt") {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 24, height: 24, top: 0, left: 0, right: 24, bottom: 24 }; };
  return vm.runInContext(buildReadScript(site), dom.getInternalVMContext());
}

console.log("\n== P37.2: read the WHOLE reply when the page splits it over several nodes ==");
{
  const runOv = (html, site, ov) => {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: "outside-only" });
    return vm.runInContext(buildReadScript(site, ov), dom.getInternalVMContext());
  };
  const older = `<div class="conversation-container"><user-query><div class="query-text">[MSG #0003] hi</div></user-query><model-response><message-content><div class="markdown markdown-main-panel"><p>[TO: USER]</p><p>older</p><p>[FROM: GEMINI]</p></div></message-content></model-response></div>`;
  // (a) the exact log case: the learned alternative 'model-response message-content .markdown'
  //     reads a node holding only "[TO:" — the rest sits in sibling nodes under message-content
  const splitA = `<div class="conversation-container"><user-query><div class="query-text">[MSG #0004] go</div></user-query><model-response><message-content><div class="markdown markdown-main-panel">[TO:</div><div class="response-tail"> USER]</div><div class="response-tail"><p>The whole body of the reply.</p><pre><code>code part</code></pre><p>[FROM: GEMINI]</p></div></message-content></model-response></div>`;
  let r = runOv(older + splitA, "gemini", { assistant: "model-response message-content .markdown", assistantStrict: true });
  assert(/\[TO:\s*USER\]/.test(r.text) && /whole body of the reply/.test(r.text) && /code part/.test(r.text) && /\[FROM: GEMINI\]\s*$/.test(r.text), `"[TO:" + sibling nodes -> the whole reply, code block included (${JSON.stringify(r.text.slice(0, 80))})`);
  assert(!/older/.test(r.text) && !/MSG #0004/.test(r.text), "never the older reply or the user's message");
  // (b) [TO: USER] and the body in sibling nodes, the body node LAST and matched alone
  const splitB = `<div class="conversation-container"><user-query><div class="query-text">[MSG #0005] go</div></user-query><model-response><message-content><div class="head-x"><p>[TO: USER]</p></div><div class="markdown"><p>Body in a sibling node.</p><p>[FROM: GEMINI]</p></div></message-content></model-response></div>`;
  r = runOv(older + splitB, "gemini", { assistant: "model-response message-content .markdown", assistantStrict: true });
  assert(/^\s*\[TO: USER\]/.test(r.text) && /Body in a sibling node/.test(r.text), `[TO: USER] and the body in sibling nodes -> both read (${JSON.stringify(r.text)})`);
  // (c) "[TO:" only, the rest OUTSIDE message-content but inside the same model-response (parentChars 4)
  const splitC = `<div class="conversation-container"><user-query><div class="query-text">[MSG #0006] go</div></user-query><model-response><div class="response-container"><message-content><div class="markdown markdown-main-panel">[TO:</div></message-content><div class="continuation"> USER]\nSplit outside message-content.\n[FROM: GEMINI]</div></div></model-response></div>`;
  r = runOv(older + splitC, "gemini", { assistant: "model-response message-content .markdown", assistantStrict: true });
  assert(/Split outside message-content/.test(r.text) && /^\s*\[TO:/.test(r.text) && /\[FROM: GEMINI\]\s*$/.test(r.text), `"[TO:" with the rest elsewhere in the same reply -> whole reply (${JSON.stringify(r.text)})`);
  // (d) a selector that reads just the first paragraph of a ChatGPT reply -> the whole message
  const gpt = `<div data-message-author-role="user"><div>[MSG #0001] hi</div></div><div data-message-author-role="assistant"><div class="markdown"><p class="first">[TO: USER]</p><p>Paragraph two is long enough to matter here.</p><ul><li>a list item</li></ul><p>[FROM: CHATGPT]</p></div></div>`;
  r = runOv(gpt, "chatgpt", { assistant: "div.markdown p.first", assistantStrict: true });
  assert(/Paragraph two/.test(r.text) && /a list item/.test(r.text) && /\[FROM: CHATGPT\]\s*$/.test(r.text) && !/MSG #0001/.test(r.text), `a selector reaching only part of the message -> the whole message (${JSON.stringify(r.text.slice(0, 60))})`);
  // (e) a normal, whole reply is left exactly as it was
  r = runOv(gpt.replace(' class="first"', ""), "chatgpt", {});
  assert(r.fragmentFixed === false || r.fragmentFixed === undefined, `an ordinary reply needs no fix (${r.fragmentFixed})`);
}

console.log("\n== generating: a visible Stop button means the model is still speaking ==");
{
  const r = runGen(`<div data-message-author-role="assistant">half a rep</div>
    <button data-testid="stop-button" aria-label="Stop generating">stop</button>`);
  assert(r.generating === true, "Stop button present -> generating:true");
  assert(r.sendReady === false, "not send-ready while generating");
}

console.log("\n== done: the Send button is back and clickable ==");
{
  const r = runGen(`<div data-message-author-role="assistant">the full reply</div>
    <button data-testid="send-button" aria-label="Send prompt">send</button>`);
  assert(r.generating === false, "only a Send button -> generating:false");
  assert(r.sendReady === true, "Send button back and enabled -> sendReady:true");
}

console.log("\n== a disabled Send button counts as generating ONLY when the composer has text ==");
{
  // No Stop button, Send disabled, but the composer still holds the in-flight
  // text — a site that disables Send mid-stream. This is genuinely generating.
  const r = runGen(`<div data-message-author-role="assistant">streaming…</div>
    <div contenteditable="true">the prompt still sitting in the box</div>
    <button data-testid="send-button" aria-label="Send prompt" disabled>send</button>`);
  assert(r.composerEmpty === false, "the composer is seen as non-empty");
  assert(r.generating === true, "disabled Send + text in composer -> generating:true");
}

console.log("\n== E03 regression: a finished reply with an EMPTY composer is NOT generating ==");
{
  // The audit case: the reply is done, but the (empty) composer leaves Send
  // disabled. This must read as idle, or the completed reply is never captured.
  const r = runGen(`<div data-message-author-role="assistant">the full, finished reply [FROM: CHATGPT]</div>
    <div contenteditable="true"></div>
    <button data-testid="send-button" aria-label="Send prompt" disabled>send</button>`);
  assert(r.composerEmpty === true, "the empty composer is detected");
  assert(r.inputFound === true, "the message box is reported as found");
  assert(r.generating === false, "disabled Send over an EMPTY composer -> generating:false (idle, not streaming)");
}

console.log("\n== a page with no message box (signed out) reports inputFound:false ==");
{
  const r = runGen(`<h1>Welcome back</h1><button>Log in</button><button>Sign up</button>`);
  assert(r.inputFound === false, "no message box on the page -> inputFound:false (BookForge won't call the pane Ready)");
}

console.log("\n== no stop/send buttons matched -> falls back (not generating) ==");
{
  const r = runGen(`<div data-message-author-role="assistant">a reply</div>`);
  assert(r.generating === false, "no buttons -> generating:false, so completion falls back to the tag/timer");
  assert(r.sendReady === false, "no Send button -> not send-ready");
}

// E11: a send into a provider-paused conversation (composer gone, a known
// safeguard marker on the page) reports PROVIDER_PAUSED with a reason, not a
// bare INPUT_NOT_FOUND. buildSendScript's IIFE is async, so await its promise.
async function runSend(html, site = "claude") {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 24, height: 24, top: 0, left: 0, right: 24, bottom: 24 }; };
  // setTimeout is used by the send script's polling; jsdom provides it.
  return await vm.runInContext(buildSendScript(site, "hello there"), dom.getInternalVMContext());
}

(async () => {
  console.log("\n== E11: a paused conversation reports PROVIDER_PAUSED, not INPUT_NOT_FOUND ==");
  {
    // No composer on the page + the exact safeguard marker the audit saw.
    const r = await runSend(`<div>Claude paused: reasoning_extraction was triggered for this conversation.</div>`);
    assert(r.ok === false && r.error === "PROVIDER_PAUSED", "a missing composer + a pause marker -> PROVIDER_PAUSED");
    assert(/reasoning_extraction/.test(r.reason || ""), "the pause reason is reported so the user knows why");
  }
  {
    // No composer and NO marker -> still the plain missing-input error (no false pause).
    const r = await runSend(`<div>just some unrelated page chrome</div>`);
    assert(r.ok === false && r.error === "INPUT_NOT_FOUND", "a missing composer with no marker stays INPUT_NOT_FOUND (no false positive)");
  }
  {
    // A real composer present -> the pause path never triggers.
    const r = await runSend(`<div contenteditable="true"></div><div>reasoning_extraction appears here as page text</div>`);
    assert(r.error !== "PROVIDER_PAUSED", "with a working composer, a stray marker never fabricates a pause");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
