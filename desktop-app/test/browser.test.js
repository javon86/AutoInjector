// test/browser.test.js — runs the REAL scripts automation.js generates
// (buildSendScript/buildReadScript) inside a REAL Chromium engine (via
// Playwright, using the browser already cached in this environment for
// Playwright — not Electron, which this sandbox can't download) against
// static HTML fixtures. test/run.js mocks executeJavaScript entirely (string
// matching, no real DOM); test/conversation.test.js uses jsdom (in-memory,
// no real rendering/typing semantics). This is the one layer that actually
// exercises document.querySelector/typing/event dispatch the way a real
// browser would, closest to what Electron's WebContentsView would do.
// Run with: node test/browser.test.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { buildSendScript, buildReadScript, buildFileInputFinderExpression, buildProbeScript } = require("../automation");

// Playwright's own auto-detected browser (e.g. what `npx playwright install`
// puts in ~/.cache/ms-playwright on a normal machine or CI runner) is tried
// first. This specific sandbox pre-caches Chromium at a fixed, non-standard
// path instead (see the environment notes on PLAYWRIGHT_BROWSERS_PATH) and
// ships a Playwright version that doesn't match what's cached there, so
// auto-detection fails here specifically — fall back to that known path only
// when it actually exists, rather than hardcoding it as the primary path.
const SANDBOX_CHROMIUM_PATH = "/opt/pw-browsers/chromium";
function resolveExecutablePath() {
  try {
    if (fs.existsSync(SANDBOX_CHROMIUM_PATH)) return SANDBOX_CHROMIUM_PATH;
  } catch {}
  return undefined; // let Playwright auto-detect its own installed browser
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

async function withFixture(file, fn, query = "") {
  const executablePath = resolveExecutablePath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    await page.goto(`file://${path.join(__dirname, "fixtures", file)}${query}`);
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function testClaudeReadReal() {
  console.log("\n== buildReadScript('claude') against a real Chromium DOM ==");
  await withFixture("claude-reply.html", async (page) => {
    const res = await page.evaluate(buildReadScript("claude"));
    assert(res.ok, "read script runs without error");
    assert(res.text.includes("Hey! I'm here and working. What can I help you with?"), `captures the real reply text (got: ${JSON.stringify(res.text)})`);
    assert(!res.text.includes("test"), "does NOT pick up the user's own message (different node, no font-claude-response-body/standard-markdown ancestor)");
  });
}

async function testClaudeReadMultiParagraph() {
  console.log("\n== buildReadScript('claude') captures the FULL reply, not just the last paragraph ==");
  await withFixture("claude-reply-multiparagraph.html", async (page) => {
    const res = await page.evaluate(buildReadScript("claude"));
    assert(res.text.includes("First paragraph of the reply."), "first paragraph is present");
    assert(res.text.includes("Second paragraph, which must not be dropped."), "second paragraph is present too — confirms container-level selector, not per-<p> selector");
  });
}

async function testClaudeSendReal() {
  console.log("\n== buildSendScript('claude') typing + send-click against a real Chromium DOM (button actually submits) ==");
  await withFixture("claude-reply.html", async (page) => {
    // Real chat UIs clear the input box the instant a message is actually
    // submitted -- simulate that so this fixture behaves like the real site
    // instead of a static page.
    await page.evaluate(() => {
      window.__clicked = false;
      const box = document.querySelector('div[contenteditable="true"]');
      document.querySelector('button[aria-label="Send Message"]').addEventListener("click", () => {
        window.__clicked = true;
        box.textContent = "";
      });
    });
    const res = await page.evaluate(buildSendScript("claude", "hello from AutoInjector"));
    assert(res.ok === true, `send script reports ok when the button genuinely submits (got: ${JSON.stringify(res)})`);
    const clicked = await page.evaluate(() => window.__clicked);
    assert(clicked === true, "the real Send button's click handler actually fired");
    const boxText = await page.evaluate(() => document.querySelector('div[contenteditable="true"]').textContent);
    assert(boxText === "", "the input box is empty afterward, confirming a real submit (not just a no-op click)");
  });
}

async function testClaudeSendNotConfirmedReal() {
  console.log("\n== buildSendScript('claude') correctly reports failure when the click does nothing ==");
  await withFixture("claude-reply.html", async (page) => {
    // No click listener attached at all this time -- clicking "Send" is a
    // real no-op, exactly like a stale/wrong SEND_CANDIDATES selector
    // matching the wrong element. Before the send-confirmation fix, the
    // script would have reported {ok:true} anyway since btn.click() itself
    // never throws.
    const res = await page.evaluate(buildSendScript("claude", "this should not silently succeed"));
    assert(res.ok === false && res.error === "SEND_NOT_CONFIRMED", `send script correctly reports failure instead of a false success (got: ${JSON.stringify(res)})`);
    const boxText = await page.evaluate(() => document.querySelector('div[contenteditable="true"]').textContent);
    assert(boxText === "this should not silently succeed", "the typed text is still sitting in the box, visible proof nothing was actually sent");
  });
}

// The ChatGPT failure in the 2026-10-21 Extract All: 58 sends to ChatGPT logged
// as "sent" (55 only on the 2nd try) and not one ChatGPT reply in 43 minutes.
// These run the send script against an editor that ignores raw DOM writes.
const sentOn = (page) => page.evaluate(() => window.__sent.slice());
async function testStrictEditorReallySends() {
  console.log("\n== buildSendScript('chatgpt') against a strict rich editor: the message REALLY goes out ==");
  await withFixture("strict-editor.html", async (page) => {
    const res = await page.evaluate(buildSendScript("chatgpt", "[MSG #0007]\n[TO: CLAUDE]\nline two\n[FROM: GEMINI]"));
    const sent = await sentOn(page);
    assert(res.ok === true && res.verified === true, `reported sent AND proven by its [MSG #] number in the chat (got: ${JSON.stringify(res)})`);
    assert(sent.length === 1, `the editor really posted it, once (posted ${sent.length})`);
    assert(sent[0] === "[MSG #0007]\n[TO: CLAUDE]\nline two\n[FROM: GEMINI]", `line breaks survive (got: ${JSON.stringify(sent[0])})`);
  });
}
async function testNoDuplicateOnSlowPage() {
  console.log("\n== a page that clears its box slowly gets the message ONCE, even when retried ==");
  await withFixture("strict-editor.html", async (page) => {
    const text = "[MSG #0042]\nonly once please";
    const first = await page.evaluate(buildSendScript("chatgpt", text));
    // what main.js does after a failed confirmation: same text, plus the first try's baseline
    const retry = await page.evaluate(buildSendScript("chatgpt", text, undefined, { markerBaseline: first.markerBaseline }));
    const sent = await sentOn(page);
    assert(first.ok === true && first.verified === true, `the first try is confirmed by its number in the chat, not by the box emptying (got: ${JSON.stringify(first)})`);
    assert(retry.ok === true && retry.method === "already-sent", `a retry sees it already went out and does not post again (got: ${JSON.stringify(retry)})`);
    assert(sent.length === 1, `posted exactly once (posted ${sent.length})`);
  }, "?slow=1");
}
async function testOldNumberOnPageAfterRestart() {
  console.log("\n== after an app restart, an old [MSG #0001] already in the chat doesn't block the new #0001 ==");
  await withFixture("strict-editor.html", async (page) => {
    await page.evaluate(() => { const d = document.createElement("div"); d.textContent = "[MSG #0001]\nfrom yesterday's run"; document.getElementById("log").appendChild(d); });
    const res = await page.evaluate(buildSendScript("chatgpt", "[MSG #0001]\ntoday's first message"));
    const sent = await sentOn(page);
    assert(res.ok === true && res.verified === true && res.method !== "already-sent", `the new message is sent, not mistaken for the old one (got: ${JSON.stringify(res)})`);
    assert(sent.length === 1 && /today/.test(sent[0]), "it really went out");
  });
}
async function testProbeScript() {
  console.log("\n== TR-08: the read-only page check finds the box/button and sends NOTHING ==");
  await withFixture("strict-editor.html", async (page) => {
    const r = await page.evaluate(buildProbeScript("chatgpt"));
    assert(r.ok && r.input.found && r.input.selector === "#prompt-textarea", `finds ChatGPT's message box (${JSON.stringify(r.input)})`);
    assert(r.send.found, "finds the Send button");
    assert((await sentOn(page)).length === 0, "and posts nothing");
  });
  await withFixture("claude-reply.html", async (page) => {
    const r = await page.evaluate(buildProbeScript("claude"));
    assert(r.ok && r.assistant.count >= 1, `counts Claude's replies on the page (${JSON.stringify(r.assistant)})`);
  });
}
async function testStrictEditorDeadButton() {
  console.log("\n== a Send button that does nothing is still reported as a failure ==");
  await withFixture("strict-editor.html", async (page) => {
    await page.evaluate(() => { const b = document.getElementById("send"); const c = b.cloneNode(true); b.replaceWith(c); c.disabled = false; });
    await page.evaluate(() => { document.getElementById("prompt-textarea").addEventListener("keydown", (e) => e.stopImmediatePropagation(), true); });
    const res = await page.evaluate(buildSendScript("chatgpt", "[MSG #0003]\nnobody will get this"));
    assert(res.ok === false && res.error === "SEND_NOT_CONFIRMED", `no false "sent" (got: ${JSON.stringify(res)})`);
    assert((await sentOn(page)).length === 0, "and nothing was posted");
  });
}

async function testFileInputFinderExpressionReal() {
  console.log("\n== buildFileInputFinderExpression('claude') against a real Chromium DOM ==");
  await withFixture("claude-reply.html", async (page) => {
    // buildFileInputFinderExpression's output is designed to be the
    // `expression` field of a CDP Runtime.evaluate call (see
    // attachFileToSite() in main.js), not something run via
    // page.evaluate() — but it's the same IIFE-returns-a-node shape as the
    // other two builders, so it's still a valid, cheap sanity check that
    // the selector-matching logic and syntax are correct against real DOM.
    // The actual CDP wiring (Runtime.evaluate's objectId ->
    // DOM.setFileInputFiles) has no Playwright equivalent — Electron's
    // webContents.debugger is a main-process-only API — so that part is
    // covered by the mocked orchestration tests in test/run.js instead.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.style.display = "none";
      document.body.appendChild(input);
    });
    const isFileInput = await page.evaluate(`(${buildFileInputFinderExpression("claude")}).tagName === "INPUT"`);
    assert(isFileInput === true, "resolves to the real <input type=\"file\"> element, not null");
  });
}

async function main() {
  await testClaudeReadReal();
  await testClaudeReadMultiParagraph();
  await testClaudeSendReal();
  await testClaudeSendNotConfirmedReal();
  await testFileInputFinderExpressionReal();
  await testStrictEditorReallySends();
  await testNoDuplicateOnSlowPage();
  await testOldNumberOnPageAfterRestart();
  await testStrictEditorDeadButton();
  await testProbeScript();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Browser test runner crashed:", e);
  process.exit(1);
});
