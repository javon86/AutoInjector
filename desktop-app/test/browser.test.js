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
const { buildSendScript, buildReadScript, buildFileInputFinderExpression, buildProbeScript, buildPickScript } = require("../automation");

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
// TR-23 / TR-24: the 21-22 Oct runs had Claude's reply selector saved as
// "span" and ChatGPT reading only the "[FROM: CHATGPT]" line of each reply.
async function testFragmentAndBareOverrides() {
  console.log("\n== TR-23/24: a saved reply selector that reads only part of the reply, or is a bare tag, can't break reading ==");
  await withFixture("claude-reply.html", async (page) => {
    await page.evaluate(() => {
      const md = document.querySelector(".standard-markdown");
      md.innerHTML = '<p>[TO: GEMINI]</p><p>The whole reply body.</p><p class="lastline">[FROM: CLAUDE]</p>';
      const junk = document.createElement("span"); junk.textContent = "Copy"; document.body.appendChild(junk);
    });
    let r = await page.evaluate(buildReadScript("claude", { assistant: "p.lastline" }));
    assert(/^\[TO: GEMINI\][\s\S]*whole reply body[\s\S]*\[FROM: CLAUDE\]/.test(r.text), `an override that reads only the last line still gets the whole reply (${JSON.stringify(r.text)})`);
    r = await page.evaluate(buildReadScript("claude", { assistant: "span" }));
    assert(/whole reply body/.test(r.text) && !/^Copy$/.test(r.text.trim()), `a bare "span" override is ignored (read: ${JSON.stringify(r.text.slice(0, 60))})`);
    const pr = await page.evaluate(buildProbeScript("claude", { assistant: "span" }));
    assert(pr.assistant.selector !== "span", `the page check ignores it too (${pr.assistant.selector})`);
  });
}
async function testSplitReplyWithNoKnownContainer() {
  console.log("\n== TR-23: a reply split into blocks, with the site's usual containers gone, is still read whole ==");
  await withFixture("strict-editor.html", async (page) => {
    await page.evaluate(() => {
      document.getElementById("log").innerHTML =
        '<div class="turn user"><div data-message-author-role="user">[MSG #0001] question … end with [FROM: CHATGPT]</div></div>' +
        '<div class="turn bot"><h6>ChatGPT said:</h6><div class="blk">[TO: USER]</div><div class="blk">Here is the answer.</div><div class="blk last">[FROM: CHATGPT]</div></div>';
    });
    const r = await page.evaluate(buildReadScript("chatgpt", { assistant: "div.blk.last" }));
    assert(/^\[TO: USER\][\s\S]*Here is the answer\.[\s\S]*\[FROM: CHATGPT\]$/.test(r.text.trim()) && r.fragmentFixed, `reads the whole reply, not just "[FROM: CHATGPT]" (${JSON.stringify(r.text)})`);
    assert(!/question/.test(r.text) && !/ChatGPT said/.test(r.text), "never pulls in the user's message or the site's heading");
    // page buttons under the reply don't tag along
    await page.evaluate(() => { const bar = document.createElement("div"); bar.textContent = "Copy  Retry  ChatGPT can make mistakes. Check important info before relying on it."; document.querySelector(".turn.bot").appendChild(bar); });
    const r2 = await page.evaluate(buildReadScript("chatgpt", { assistant: "div.blk.last" }));
    assert(/\[FROM: CHATGPT\]$/.test(r2.text.trim()), `the read stops at the closing tag, not the page's buttons (${JSON.stringify(r2.text.slice(-60))})`);
    // a quoted [TO: …] INSIDE an untagged reply is never taken as the routing tag
    await page.evaluate(() => { document.getElementById("log").innerHTML = '<div class="turn bot"><div class="blk only">Sure. Start each reply with [TO: ALL] when you want everyone. Done. [FROM: CLAUDE]</div><div>Copy</div></div>'; });
    const r3 = await page.evaluate(buildReadScript("claude", { assistant: "div.blk.only" }));
    assert(/^Sure\./.test(r3.text.trim()) && !r3.fragmentFixed, `a quoted tag isn't used to re-cut the reply (${JSON.stringify(r3.text.slice(0, 40))})`);
  });
}
async function testPickerSnapsToWholeReply() {
  console.log("\n== TR-24: picking a reply by clicking a word inside it saves the WHOLE reply's container ==");
  await withFixture("claude-reply.html", async (page) => {
    const pending = page.evaluate(buildPickScript("assistant", "claude"));
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector(".standard-markdown p").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    const r = await pending;
    assert(r.ok && /standard-markdown/.test(r.selector) && r.selector !== "p", `the picked selector is the reply container, not the clicked paragraph (${r.selector})`);
  });
}
async function testAiBusyNotTyped() {
  console.log("\n== TR-25: while the AI is still writing (Stop button showing), the app waits instead of typing ==");
  await withFixture("strict-editor.html", async (page) => {
    await page.evaluate(() => { const s = document.createElement("button"); s.setAttribute("data-testid", "stop-button"); s.textContent = "Stop"; document.body.appendChild(s); });
    const r = await page.evaluate(buildSendScript("chatgpt", "[MSG #0099]\nnot yet"));
    assert(r.ok === false && r.error === "AI_BUSY", `reports AI_BUSY (got ${JSON.stringify(r)})`);
    const box = await page.evaluate(() => document.getElementById("prompt-textarea").textContent);
    assert(box === "" && (await sentOn(page)).length === 0, "nothing was typed or sent");
  });
}
// TR-27: the live ChatGPT overrides named a WRAPPER div ("Ask ChatGPT") as the
// message box, with a hidden "Send" button first on the page. Every relay to
// ChatGPT then failed with SEND_NOT_CONFIRMED.
async function testWrapperOverrideStillSends() {
  console.log("\n== TR-27: a saved message-box selector that names a WRAPPER still sends into the real editor ==");
  await withFixture("wrapped-editor.html", async (page) => {
    const ov = { input: 'div[aria-label="Ask ChatGPT"]', send: 'button[aria-label="Send"]' };
    const res = await page.evaluate(buildSendScript("chatgpt", "[MSG #0071]\n[TO: CLAUDE]\nthrough the wrapper\n[FROM: GEMINI]", ov));
    const sent = await sentOn(page);
    assert(res.ok === true && res.verified === true, `sent and proven (got: ${JSON.stringify(res)})`);
    assert(sent.length === 1 && sent[0] === "[MSG #0071]\n[TO: CLAUDE]\nthrough the wrapper\n[FROM: GEMINI]", `the editor posted the whole message once (got: ${JSON.stringify(sent)})`);
    const wrapperText = await page.evaluate(() => document.querySelector(".placeholder") !== null);
    assert(wrapperText, "the wrapper's own contents (placeholder) were not overwritten");
  });
  await withFixture("wrapped-editor.html", async (page) => {
    const pending = page.evaluate(buildPickScript("input", "chatgpt"));
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelector(".placeholder").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    const r = await pending;
    assert(r.ok && /prompt-textarea/.test(r.selector), `picking the box by clicking its placeholder saves the real editable box (${r.selector})`);
  });
}
// TR-31: the reader saw only "[TO:" because the reply was split across blocks.
async function testSplitReplyClimb() {
  console.log("\n== TR-31: a reply split across page blocks is read whole, not just its first line ==");
  await withFixture("split-reply.html", async (page) => {
    const res = await page.evaluate(buildReadScript("gemini"));
    assert(/^\[TO: ALL\]/.test(res.text.trim()) && /rest of my reply/.test(res.text) && /\[FROM: GEMINI\]$/.test(res.text.trim()), `the whole reply is read (got ${JSON.stringify(res.text)})`);
    assert(!/MSG #0013/.test(res.text), "the user's message is not pulled in");
  });
}
// TR-30: an AI still writing whose Stop button isn't recognised.
async function testNoStopButtonStreaming() {
  console.log("\n== TR-30: Send stays locked while the page is still writing → wait (AI_BUSY), don't click when it unlocks ==");
  await withFixture("no-stop-streaming.html", async (page) => {
    const res = await page.evaluate(buildSendScript("chatgpt", "[MSG #0020]\nnext message"));
    assert(res.ok === false && res.error === "AI_BUSY" && !!res.busyHow, `reports AI_BUSY instead of sending into a reply that's still being written (got ${JSON.stringify(res)})`);
    assert((await sentOn(page)).length === 0, "nothing was sent");
  });
}
// TR-27 follow-up: the wrapper also holds a hidden fallback textarea.
async function testWrapperHiddenFallback() {
  console.log("\n== TR-27: a hidden fallback box inside the wrapper is skipped for the visible editor ==");
  await withFixture("wrapped-editor-fallback.html", async (page) => {
    const ov = { input: 'div[aria-label="Ask ChatGPT"]', send: 'button[aria-label="Send"]' };
    const res = await page.evaluate(buildSendScript("chatgpt", "[MSG #0072]\nvia the visible editor", ov));
    const sent = await sentOn(page);
    assert(res.ok === true && sent.length === 1 && sent[0] === "[MSG #0072]\nvia the visible editor", `sent through the visible editor (got ${JSON.stringify(res)} / ${JSON.stringify(sent)})`);
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
    assert(res.diag && res.diag.input && res.diag.input.editable === true && res.diag.button && typeof res.diag.boxChars === "number", `a failed send reports what it used, for the Activity Log (${JSON.stringify(res.diag)})`);
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

// Page chrome around a reply (screen-reader headings, Claude's thinking summary,
// code-block headers, timestamps) is skipped by element — with real layout, where
// innerText DOES read sr-only text, unlike jsdom.
async function testReplyChromeSkipped() {
  console.log("\n== reply page chrome is skipped by element (real innerText) ==");
  await withFixture("reply-chrome.html", async (page) => {
    const res = await page.evaluate(buildReadScript("chatgpt"));
    assert(res.ok && res.text.trim() === "KVA4MK-JNIOTUA", `ChatGPT: no "ChatGPT said:" heading (got ${JSON.stringify(res.text)})`);
  }, "?site=chatgpt");
  await withFixture("reply-chrome.html", async (page) => {
    const res = await page.evaluate(buildReadScript("claude"));
    assert(res.ok && res.text.trim() === "ML15WG-JNIOTUA", `Claude: no preview line, thinking summary or "just now" (got ${JSON.stringify(res.text)})`);
    const styled = await page.evaluate(() => document.querySelectorAll("[style]").length);
    assert(styled === 0, "Claude: the hidden parts are restored exactly (no inline style left behind)");
    const shown = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="thinking-block"]')).display);
    assert(shown !== "none", "Claude: the thinking block is visible again after the read");
  }, "?site=claude");
  await withFixture("reply-chrome.html", async (page) => {
    const res = await page.evaluate(buildReadScript("gemini"));
    assert(res.ok && !/Gemini said/.test(res.text), `Gemini: no "Gemini said" (got ${JSON.stringify(res.text)})`);
    assert(!/Python|Copy code/.test(res.text), "Gemini: the code-block label and copy button are skipped");
    assert(/^token = "AUTOINJ-UYORFD"$/m.test(res.text) && /^DFROYU-JNIOTUA$/m.test(res.text), "Gemini: the code and the answer keep their own lines");
  }, "?site=gemini");
}

// 🎨 ChatGPT image engine (chatgpt-image.js): the image reader and the 🎯 "Generated picture"
// picker, in real Chromium. 1) fake-chat.html?image=ok&avatar=1 (a blurred preview, then the
// picture, plus a 28 px avatar in the turn); 2) a page shaped like ChatGPT's real image turns as
// far as we know them (article[data-turn="assistant"] > … > div.group/imagegen-image with a
// blurred aria-hidden backdrop <img> and the real <img alt="Generated image">, the user's own
// uploaded picture in the user turn) — the selectors in selectors.js IMAGE_CANDIDATES must find
// exactly the finished picture.
async function testChatImageSelectorsReal() {
  console.log("\n== ChatGPT images: IMAGE_CANDIDATES + the scan script + 🎯 Generated picture (real Chromium) ==");
  const CI = require("../chatgpt-image");
  const SR = require("../self-repair");
  const SITES = require("../selectors");
  await withFixture("fake-chat.html", async (page) => {
    const r = await page.evaluate(buildSendScript("chatgpt", "[MSG #0001]\nCreate an image: a lighthouse keeper", {}, {}));
    assert(r && r.ok, "the image request is sent with the real send script");
    await page.waitForFunction(() => window.__fake.dump().replies.some((x) => x.image && x.src), null, { timeout: 8000 });
    const sc = await page.evaluate(CI.buildScanScript(CI.defaultSelectors()));
    const good = (sc.last && sc.last.images || []).filter((i) => i.complete && !i.avatar && !i.blurred && !i.hidden && i.nw >= 200);
    assert(sc.turns === 1 && good.length === 1 && good[0].alt === "Generated image" && good[0].nw === 512, `the scan finds exactly the finished picture in the newest turn (${JSON.stringify(sc.last && sc.last.images.map((i) => ({ alt: i.alt, nw: i.nw, avatar: i.avatar, blurred: i.blurred })))})`);
    assert(sc.last.images.some((i) => i.avatar && i.nw === 28), "the 28 px avatar is seen and marked as an avatar (ignored)");
    const first = await page.evaluate((sel) => { const l = document.querySelectorAll(sel); return l.length; }, SITES.chatgpt.IMAGE_CANDIDATES[0]);
    assert(first >= 1, `IMAGE_CANDIDATES[0] (${SITES.chatgpt.IMAGE_CANDIDATES[0]}) matches in the assistant turn`);
    // 🎯 Generated picture: clicking the picture saves a selector for it; the avatar is refused
    let pick = page.evaluate(SR.buildPickScript("chatgpt", "image", "ChatGPT", SITES, 8000));
    await page.waitForTimeout(150);
    await page.click('img[alt="Generated image"]');
    let res = await pick;
    const n = res && res.ok ? await page.evaluate((sel) => document.querySelectorAll(sel).length, res.selector) : 0;
    assert(res && res.ok && res.role === "image" && res.selector !== "img" && n >= 1 && n <= 3 && /Picture found \(512×768\)/.test(res.preview), `🎯 Generated picture: a click on the picture gives a selector for it (${res && res.selector}, ${n} match)`);
    pick = page.evaluate(SR.buildPickScript("chatgpt", "image", "ChatGPT", SITES, 8000));
    await page.waitForTimeout(150);
    await page.click("img.avatar");
    res = await pick;
    assert(res && !res.ok && res.error === "TOO_SMALL", `clicking the 28 px avatar is refused (${res && res.error})`);
  }, "?site=chatgpt&quirks=none&image=ok&avatar=1&imgdelay=400&speed=0.3");

  await withFixture("fake-chat.html", async (page) => {
    // ChatGPT-like markup, built in the page (pictures drawn on canvases so they really load)
    await page.evaluate(async () => {
      const draw = (w, h, c) => { const k = document.createElement("canvas"); k.width = w; k.height = h; const g = k.getContext("2d"); g.fillStyle = c; g.fillRect(0, 0, w, h); g.fillStyle = "#fff"; g.fillRect(w / 4, h / 4, w / 2, h / 2); return k.toDataURL("image/png"); };
      document.getElementById("log").innerHTML = `
        <article data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user"><img id="upload" alt="Uploaded image" src="${draw(600, 600, "#a33")}" style="width:300px"><div class="whitespace-pre-wrap">make her from the side</div></div></article>
        <article data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>Here you go.</p></div></div>
          <div class="group/imagegen-image relative"><img aria-hidden="true" class="absolute blur-2xl" alt="" src="${draw(1024, 1536, "#335")}" style="width:256px;height:384px">
          <img id="final" alt="Generated image" class="w-full" src="${draw(1024, 1536, "#335")}" style="width:256px;height:384px"></div>
          <div class="flex"><button aria-label="Copy"><img alt="" src="${draw(16, 16, "#000")}" width="16" height="16"></button></div></article>`;
      await new Promise((r) => setTimeout(r, 100));
    });
    const sc = await page.evaluate(CI.buildScanScript(CI.defaultSelectors()));
    const good = (sc.last && sc.last.images || []).filter((i) => i.complete && !i.avatar && !i.blurred && !i.hidden && i.nw >= 200);
    assert(sc.turns === 1 && good.length === 1 && good[0].alt === "Generated image" && good[0].nw === 1024, `ChatGPT-like markup: only the finished picture qualifies — not the blurred backdrop, the button icon or the user's upload (${JSON.stringify((sc.last && sc.last.images || []).map((i) => ({ alt: i.alt, nw: i.nw, blurred: i.blurred, hidden: i.hidden, avatar: i.avatar })))})`);
    assert(!sc.srcs.some((x) => x === (sc.last && sc.last.images.find((i) => i.alt === "Uploaded image") || {}).src), "the user's own upload is never a candidate");
    const pick = page.evaluate(SR.buildPickScript("chatgpt", "image", "ChatGPT", SITES, 8000));
    await page.waitForTimeout(150);
    await page.click("#final", { force: true });
    const res = await pick;
    const matches = res && res.ok ? await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.id || e.getAttribute("aria-hidden") || "?"), res.selector) : [];
    assert(res && res.ok && matches.includes("final") && !matches.includes("upload"), `🎯 on ChatGPT-like markup: ${res && res.selector} → ${JSON.stringify(matches)}`);
  }, "?site=chatgpt&quirks=none");
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
  await testFragmentAndBareOverrides();
  await testSplitReplyWithNoKnownContainer();
  await testPickerSnapsToWholeReply();
  await testAiBusyNotTyped();
  await testWrapperOverrideStillSends();
  await testSplitReplyClimb();
  await testNoStopButtonStreaming();
  await testWrapperHiddenFallback();
  await testReplyChromeSkipped();
  await testChatImageSelectorsReal();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Browser test runner crashed:", e);
  process.exit(1);
});
