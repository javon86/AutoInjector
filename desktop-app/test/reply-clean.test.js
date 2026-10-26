// test/reply-clean.test.js — page chrome never reaches a captured reply.
// The exact strings below are real captures from a user's log (Windows, live
// sites): ChatGPT's "ChatGPT said:" heading, Claude's "Claude responded: …"
// preview + thinking summary + "just now", Gemini's "Gemini said" and its code
// label / "Code output" glued to the code. Covers the text backup
// (reply-clean.js) and the DOM layer (the read script skips those elements),
// in jsdom; test/browser.test.js runs the DOM layer in real Chromium.
// Run: node test/reply-clean.test.js
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { cleanReplyText, excludeSelectorsFor } = require("../reply-clean");
const { buildReadScript } = require("../automation");
const env = require("../envelope");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const J = JSON.stringify;

console.log("\n== text backup: the real captures from the log ==");
{
  const a = cleanReplyText("chatgpt", "ChatGPT said:\n\nKVA4MK-JNIOTUA");
  assert(a === "KVA4MK-JNIOTUA", `ChatGPT heading stripped (got ${J(a)})`);
  const b = cleanReplyText("chatgpt", "ChatGPT said:\n\n[TO: USER]\nConfirmed…");
  assert(b === "[TO: USER]\nConfirmed…", `ChatGPT heading stripped, the [TO:] tag now starts the reply (got ${J(b)})`);
  assert(env.parseRoundtableTag(b).explicit === true && env.parseRoundtableTag(b).tag === "USER", "…so relay routing reads its [TO: USER]");
  const c = cleanReplyText("claude", "Claude responded: ML15WG-JNIOTUA\nReversing the given character string.\nReversing the given character string.\n\nML15WG-JNIOTUA\n\n\n\n\n\n\njust now");
  assert(c === "ML15WG-JNIOTUA", `Claude preview line, thinking summary (x2) and "just now" all stripped (got ${J(c)})`);
  const d = cleanReplyText("gemini", " Gemini said L8E8GE-JNIOTUA");
  assert(d === "L8E8GE-JNIOTUA", `Gemini heading stripped (got ${J(d)})`);
  const e = cleanReplyText("gemini", "Pythontoken = \"AUTOINJ-UYORFD\"\nprint(token[::-1])\n\nCode outputDFROYU-JNIOTUA\n\nDFROYU-JNIOTUA");
  assert(e.startsWith("Python\ntoken = \"AUTOINJ-UYORFD\"\n"), `Gemini code label separated from the code (got ${J(e)})`);
  assert(e.includes("\nCode output\nDFROYU-JNIOTUA"), "Gemini \"Code output\" label on its own line, the output on the next");
  assert(e.split("\n").filter((l) => l === "DFROYU-JNIOTUA").length === 2, "the reversed token stands on its own lines");
}

console.log("\n== text backup: conservative — real content is never stripped ==");
{
  const mid = "[TO: USER]\nWhen I asked, ChatGPT said: no.\n[FROM: CLAUDE]";
  assert(cleanReplyText("chatgpt", mid) === mid, "\"ChatGPT said:\" in the middle of a reply is kept");
  assert(cleanReplyText("claude", mid) === mid, "unchanged text is returned as-is (claude)");
  const startsSaid = "ChatGPT said: that was wrong, here is why";
  assert(cleanReplyText("chatgpt", startsSaid) === startsSaid, "a first line that continues after \"ChatGPT said:\" is real content");
  const gem = "Gemini said that already.";
  assert(cleanReplyText("gemini", gem) === gem, "a reply genuinely starting \"Gemini said that…\" is kept");
  const onlyHeading = "ChatGPT said:";
  assert(cleanReplyText("chatgpt", onlyHeading) === onlyHeading, "never cleans a reply down to nothing");
  const justNowMid = "It happened just now\nand then again.";
  assert(cleanReplyText("claude", justNowMid) === justNowMid, "\"just now\" inside a line is kept");
  const tsOnly = "just now";
  assert(cleanReplyText("claude", tsOnly) === tsOnly, "a reply that is only a time phrase is kept");
  const two = "Yes.\nYes.\n\nThat's my answer.";
  assert(cleanReplyText("chatgpt", two) === two, "a doubled first line on ChatGPT is not touched (thinking echo is Claude-only)");
  const envDup = "[TO: USER]\n[TO: USER]\n\nhi";
  assert(cleanReplyText("claude", envDup) === envDup, "a doubled envelope line is never taken for a thinking summary");
  const prose = "Pythonic code is easy to read.";
  assert(cleanReplyText("gemini", prose) === prose, "\"Pythonic …\" prose is not split as a code label");
  assert(cleanReplyText("gemini", "Code output is shown below.") === "Code output is shown below.", "\"Code output is…\" prose is kept");
  assert(cleanReplyText("claude", "") === "" && cleanReplyText("claude", null) === "", "empty / null input is safe");
  const ago = cleanReplyText("chatgpt", "[TO: USER]\nDone.\n[FROM: CHATGPT]\n5 minutes ago");
  assert(ago === "[TO: USER]\nDone.\n[FROM: CHATGPT]", `trailing "5 minutes ago" stripped (got ${J(ago)})`);
  assert(env.hasEndTag(ago), "…and the [FROM:] end tag is the last thing again");
}

console.log("\n== downstream: Akọwe JSON + envelope parsing still work on cleaned text ==");
{
  const raw = "ChatGPT said:\n\n{\"type\":\"chapter\",\"text\":\"Hello\"}";
  const t = cleanReplyText("chatgpt", raw);
  let parsed = null; try { parsed = JSON.parse(t); } catch (_) {}
  assert(parsed && parsed.type === "chapter", `cleaned reply parses as the bridge's JSON (got ${J(t)})`);
  const claudeEnv = cleanReplyText("claude", "Claude responded: [TO: GEMINI] hi\n[TO: GEMINI] hi there\n[FROM: CLAUDE]\n\njust now");
  assert(env.parseRoundtableTag(claudeEnv).tag === "GEMINI" && env.hasEndTag(claudeEnv), `Claude envelope intact (got ${J(claudeEnv)})`);
}

console.log("\n== exclude selectors are site-specific and valid CSS ==");
{
  const dom = new JSDOM("<!doctype html><body></body>");
  for (const site of ["chatgpt", "claude", "gemini", "generic"]) {
    const sel = excludeSelectorsFor(site).join(", ");
    let ok = true; try { dom.window.document.querySelectorAll(sel); } catch (_) { ok = false; }
    assert(ok, `${site}: the exclude list is a valid selector`);
  }
  assert(excludeSelectorsFor("claude").some((s) => /thinking/.test(s)), "Claude skips the thinking disclosure");
  assert(excludeSelectorsFor("gemini").some((s) => /code-block-decoration/.test(s)), "Gemini skips the code-block header");
  assert(excludeSelectorsFor("chatgpt").includes(".sr-only"), "every site skips screen-reader-only text");
}

function read(html, site) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: "outside-only" });
  const r = vm.runInContext(buildReadScript(site), dom.getInternalVMContext());
  return { r, dom };
}

console.log("\n== DOM layer (jsdom): the read script skips page chrome by element ==");
{
  const { r } = read(`
    <article data-turn="assistant"><h5 class="sr-only">ChatGPT said:</h5>
      <div data-message-author-role="assistant"><div class="markdown"><p>KVA4MK-JNIOTUA</p></div></div>
    </article>`, "chatgpt");
  assert(r.ok && r.text.trim() === "KVA4MK-JNIOTUA", `ChatGPT: the sr-only heading is not read (got ${J(r.text)})`);
}
{
  const html = `
    <div data-testid="user-message">Reverse AUTOINJ-ABCDEF</div>
    <div class="font-claude-response">
      <span class="sr-only">Claude responded: ML15WG-JNIOTUA</span>
      <div data-testid="thinking-block"><button>Reversing the given character string.</button><div>Reversing the given character string.</div></div>
      <div class="standard-markdown"><p>ML15WG-JNIOTUA</p></div>
      <div class="actions"><time datetime="2026-10-26">just now</time></div>
    </div>`;
  const { r, dom } = read(html, "claude");
  assert(r.ok && r.text.trim() === "ML15WG-JNIOTUA", `Claude: reads just the answer (got ${J(r.text)})`);
  assert(!dom.window.document.querySelector("[style]"), "the page DOM is left exactly as it was (no inline styles left behind)");
}
{
  // A Claude reply whose markdown node is short versus its container: the
  // container is read (P37.2) — still without the chrome.
  const html = `
    <div class="font-claude-response">
      <span class="sr-only">Claude responded: [TO: USER] Here</span>
      <div data-testid="thinking-block">Thinking about the request and planning the answer at some length here.</div>
      <div class="standard-markdown"><p>[TO:</p></div><div class="standard-markdown"><p>USER] Here is the full answer.</p><p>[FROM: CLAUDE]</p></div>
      <time>just now</time>
    </div>`;
  const { r } = read(html, "claude");
  assert(!/Claude responded|Thinking about|just now/.test(r.text), `Claude container read keeps chrome out (got ${J(r.text)})`);
}
{
  const html = `
    <user-query>Reverse AUTOINJ-UYORFD</user-query>
    <model-response><message-content><div class="markdown">
      <span class="cdk-visually-hidden">Gemini said</span>
      <code-block><div class="code-block-decoration"><span>Python</span><button>Copy</button></div><pre><code>token = "AUTOINJ-UYORFD"
print(token[::-1])</code></pre></code-block>
      <p>DFROYU-JNIOTUA</p>
    </div></message-content></model-response>`;
  const { r } = read(html, "gemini");
  assert(r.ok && !/Gemini said/.test(r.text), `Gemini: the visually-hidden heading is not read (got ${J(r.text)})`);
  assert(!/Python|Copy/.test(r.text), "Gemini: the code-block header (language label + copy button) is not read");
  assert(/token = "AUTOINJ-UYORFD"/.test(r.text) && /DFROYU-JNIOTUA/.test(r.text), "Gemini: the code and the answer are kept");
}
{
  // Nothing to skip: identical to the old behaviour.
  const { r } = read(`<div class="standard-markdown"><p>Plain reply.</p></div>`, "claude");
  assert(r.text === "Plain reply.", `no chrome → the text is exactly what it was (got ${J(r.text)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
