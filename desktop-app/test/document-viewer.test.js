// test/document-viewer.test.js — runs the REAL document-viewer.html/js in
// jsdom with window.api stubbed the way preload.js exposes it. This is the
// standalone popup window for previewing a document before sending it;
// test/run.js only covers that main.js opens/targets this window correctly
// (document:choose/document:read/document:send orchestration) — this file
// covers what actually happens inside the page itself. Highlighting here is
// intentionally tested at the "does the interaction wire up" level, not
// pixel-by-pixel — jsdom doesn't implement a real <canvas> 2D context, and
// the real rendering only matters inside actual Chromium anyway (same
// division of labor as everywhere else in this test suite). Run with:
// node test/document-viewer.test.js
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

function makeApi({ readResult, enabled } = {}) {
  const calls = [];
  const api = {
    calls,
    readDocument: async (p) => { calls.push({ fn: "readDocument", path: p }); return readResult; },
    sendDocument: async (p, targets) => { calls.push({ fn: "sendDocument", path: p, targets }); return { ok: true, results: Object.fromEntries(targets.map((t) => [t, { ok: true }])) }; },
    getState: async () => ({ ok: true, global: { enabled: enabled || { chatgpt: true, claude: true, gemini: true } } }),
    closeDocumentViewer: async () => { calls.push({ fn: "closeDocumentViewer" }); return { ok: true }; }
  };
  return api;
}

async function loadWindow(api, { search = "" } = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "document-viewer.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://localhost/document-viewer.html${search}`, pretendToBeVisual: true });
  dom.window.api = api;
  const script = fs.readFileSync(path.join(__dirname, "..", "document-viewer.js"), "utf8");
  dom.window.eval(script);
  await new Promise((r) => setTimeout(r, 20));
  return dom;
}

function click(dom, id) {
  dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

async function testMissingPathHandledGracefully() {
  console.log("\n== No '?path=' in the URL — doesn't crash, shows an error state ==");
  const dom = await loadWindow(makeApi({ readResult: { ok: false, error: "NO_PATH" } }));
  const doc = dom.window.document;
  assert(doc.getElementById("doc-status").textContent.includes("Couldn't open"), "shows a clear error instead of a blank/broken page");
}

async function testImageRendersWithHighlightControls() {
  console.log("\n== image kind — renders an <img> + highlight canvas, mouse interaction doesn't crash ==");
  const readResult = { ok: true, kind: "image", name: "shot.png", size: 1234, fileUrl: "file:///tmp/shot.png" };
  const dom = await loadWindow(makeApi({ readResult }), { search: "?path=%2Ftmp%2Fshot.png" });
  const doc = dom.window.document;

  const img = doc.getElementById("doc-image");
  assert(!!img && img.src === "file:///tmp/shot.png", "image src is set from the fileUrl document:read returned");
  assert(!!doc.getElementById("highlight-canvas"), "a highlight canvas overlay is present");
  assert(doc.getElementById("btn-clear-highlights").style.display !== "none", "Clear Highlights becomes available for images");
  assert(doc.getElementById("btn-mark-selection").style.display === "none", "Mark Selection (the text-only tool) stays hidden for images");

  const canvas = doc.getElementById("highlight-canvas");
  let threw = false;
  try {
    canvas.dispatchEvent(new dom.window.MouseEvent("mousedown", { clientX: 5, clientY: 5 }));
    canvas.dispatchEvent(new dom.window.MouseEvent("mousemove", { clientX: 40, clientY: 40 }));
    canvas.dispatchEvent(new dom.window.MouseEvent("mouseup", { clientX: 40, clientY: 40 }));
  } catch (e) {
    threw = true;
  }
  assert(!threw, "the draw-a-highlight-rectangle interaction wires up without throwing");

  let clearThrew = false;
  try { click(dom, "btn-clear-highlights"); } catch { clearThrew = true; }
  assert(!clearThrew, "Clear Highlights doesn't throw either");
}

async function testTextRendersAndMarkSelection() {
  console.log("\n== text kind — renders the real content, Mark Selection wraps a selection in <mark> ==");
  const readResult = { ok: true, kind: "text", tooLarge: false, name: "note.txt", size: 11, text: "hello world" };
  const dom = await loadWindow(makeApi({ readResult }), { search: "?path=%2Ftmp%2Fnote.txt" });
  const doc = dom.window.document;
  const box = doc.getElementById("doc-text");
  assert(!!box && box.textContent === "hello world", "the real file content is rendered as text");
  assert(doc.getElementById("btn-mark-selection").style.display !== "none", "Mark Selection is available for text");
  assert(doc.getElementById("btn-clear-highlights").style.display === "none", "Clear Highlights (the image-only tool) stays hidden for text");

  const range = doc.createRange();
  range.setStart(box.firstChild, 0);
  range.setEnd(box.firstChild, 5); // "hello"
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  click(dom, "btn-mark-selection");
  const mark = box.querySelector("mark");
  assert(!!mark && mark.textContent === "hello", `the selected text is wrapped in a <mark> (got ${mark ? `"${mark.textContent}"` : "none"})`);
}

async function testTextTooLargeShowsMessageNoMarkTool() {
  console.log("\n== text kind, tooLarge — shows the size-limit message instead of the content ==");
  const readResult = { ok: true, kind: "text", tooLarge: true, name: "huge.txt", size: 999999, text: "" };
  const dom = await loadWindow(makeApi({ readResult }), { search: "?path=%2Ftmp%2Fhuge.txt" });
  const doc = dom.window.document;
  assert(doc.getElementById("preview").textContent.toLowerCase().includes("too large"), "shows a 'too large to preview' message");
  assert(!doc.getElementById("doc-text"), "no text content box is rendered when it's too large to show");
}

async function testPdfRendersIframeNoHighlightControls() {
  console.log("\n== pdf kind — embeds via iframe, no highlight tools (not supported for PDFs in this version) ==");
  const readResult = { ok: true, kind: "pdf", name: "doc.pdf", size: 5000, fileUrl: "file:///tmp/doc.pdf" };
  const dom = await loadWindow(makeApi({ readResult }), { search: "?path=%2Ftmp%2Fdoc.pdf" });
  const doc = dom.window.document;
  const frame = doc.getElementById("pdf-frame");
  assert(!!frame && frame.src === "file:///tmp/doc.pdf", "the pdf is embedded via an iframe pointed at its fileUrl");
  assert(doc.getElementById("btn-mark-selection").style.display === "none" && doc.getElementById("btn-clear-highlights").style.display === "none", "neither highlight tool is shown for PDFs");
}

async function testOtherKindNoPreviewSendStillWorks() {
  console.log("\n== other kind (unrecognized extension) — no preview, but Send row still works ==");
  const readResult = { ok: true, kind: "other", name: "archive.zip", size: 4096 };
  const dom = await loadWindow(makeApi({ readResult }), { search: "?path=%2Ftmp%2Farchive.zip" });
  const doc = dom.window.document;
  assert(!doc.getElementById("doc-image") && !doc.getElementById("doc-text") && !doc.getElementById("pdf-frame"), "no preview element for an unrecognized file type");
  assert(!!doc.getElementById("btn-send-doc"), "the Send button is still there — you can send a file you can't preview");
}

async function testSendCollectsCheckedTargetsOnly() {
  console.log("\n== Send collects only the checked AIs and calls sendDocument with the real path ==");
  const readResult = { ok: true, kind: "other", name: "notes.txt", size: 12 };
  const api = makeApi({ readResult });
  const dom = await loadWindow(api, { search: "?path=%2Ftmp%2Fnotes.txt" });
  const doc = dom.window.document;

  doc.getElementById("send-chatgpt").checked = true;
  doc.getElementById("send-claude").checked = false;
  doc.getElementById("send-gemini").checked = true;
  click(dom, "btn-send-doc");
  await new Promise((r) => setTimeout(r, 20));

  const sendCall = api.calls.find((c) => c.fn === "sendDocument");
  assert(!!sendCall, "clicking Send calls sendDocument");
  assert(sendCall.path === "/tmp/notes.txt", "with the real decoded file path");
  assert(JSON.stringify(sendCall.targets) === JSON.stringify(["chatgpt", "gemini"]), `only the checked targets are included (got ${JSON.stringify(sendCall.targets)})`);
}

async function testCheckboxDefaultsReflectEnabledParticipants() {
  console.log("\n== Send checkboxes default to the currently-enabled participants ==");
  const readResult = { ok: true, kind: "other", name: "notes.txt", size: 12 };
  const dom = await loadWindow(makeApi({ readResult, enabled: { chatgpt: true, claude: false, gemini: true } }), { search: "?path=%2Ftmp%2Fnotes.txt" });
  const doc = dom.window.document;
  assert(doc.getElementById("send-chatgpt").checked === true, "chatgpt (enabled) starts checked");
  assert(doc.getElementById("send-claude").checked === false, "claude (disabled) starts unchecked");
  assert(doc.getElementById("send-gemini").checked === true, "gemini (enabled) starts checked");
}

async function testCloseCallsCloseDocumentViewer() {
  console.log("\n== Close calls closeDocumentViewer ==");
  const api = makeApi({ readResult: { ok: true, kind: "other", name: "x.bin", size: 1 } });
  const dom = await loadWindow(api, { search: "?path=%2Ftmp%2Fx.bin" });
  click(dom, "btn-close");
  await new Promise((r) => setTimeout(r, 20));
  assert(api.calls.some((c) => c.fn === "closeDocumentViewer"), "Close calls window.api.closeDocumentViewer");
}

async function main() {
  await testMissingPathHandledGracefully();
  await testImageRendersWithHighlightControls();
  await testTextRendersAndMarkSelection();
  await testTextTooLargeShowsMessageNoMarkTool();
  await testPdfRendersIframeNoHighlightControls();
  await testOtherKindNoPreviewSendStillWorks();
  await testSendCollectsCheckedTargetsOnly();
  await testCheckboxDefaultsReflectEnabledParticipants();
  await testCloseCallsCloseDocumentViewer();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
