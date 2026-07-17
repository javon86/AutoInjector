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
const { buildSendScript, buildReadScript } = require("../automation");

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

async function withFixture(file, fn) {
  const executablePath = resolveExecutablePath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    await page.goto(`file://${path.join(__dirname, "fixtures", file)}`);
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
  console.log("\n== buildSendScript('claude') typing + send-click against a real Chromium DOM ==");
  await withFixture("claude-reply.html", async (page) => {
    await page.evaluate(() => {
      window.__clicked = false;
      document.querySelector('button[aria-label="Send Message"]').addEventListener("click", () => { window.__clicked = true; });
    });
    const res = await page.evaluate(buildSendScript("claude", "hello from AutoInjector"));
    assert(res.ok, `send script reports ok (got: ${JSON.stringify(res)})`);
    const boxText = await page.evaluate(() => document.querySelector('div[contenteditable="true"]').textContent);
    assert(boxText === "hello from AutoInjector", `the contenteditable box actually contains the typed text (got: ${JSON.stringify(boxText)})`);
    const clicked = await page.evaluate(() => window.__clicked);
    assert(clicked === true, "the real Send button's click handler actually fired");
  });
}

async function main() {
  await testClaudeReadReal();
  await testClaudeReadMultiParagraph();
  await testClaudeSendReal();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Browser test runner crashed:", e);
  process.exit(1);
});
