// test/envelope.test.js — the [TO:]/[FROM:] envelope parser (envelope.js), pulled
// out of main.js so it can be exercised directly. Covers the routing-tag parse,
// the closing-tag completion signal, the E04 quoted/fenced-example guard, and the
// E05 [TO: BUTLER] destination. Run: node test/envelope.test.js
const e = require("../envelope");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function testRoutingTag() {
  console.log("\n== parseRoundtableTag: routing tag at the start is recognized + stripped ==");
  assert(e.parseRoundtableTag("[TO: GEMINI]\nhello").tag === "GEMINI", "[TO: GEMINI] -> GEMINI");
  assert(e.parseRoundtableTag("[TO: GEMINI]\nhello").body === "hello", "the tag is stripped from the body");
  assert(e.parseRoundtableTag("just talking").tag === "USER", "no tag -> defaults to USER (Rule 1)");
  assert(e.parseRoundtableTag("just talking").body === "just talking", "an untagged body is returned intact");
  assert(e.parseRoundtableTag("[TO: ALL] hi").tag === "ALL", "[TO: ALL] is recognized");
}

function testButlerDestination() {
  console.log("\n== E05: [TO: BUTLER] is a real destination, not a fallback to USER ==");
  const p = e.parseRoundtableTag("[TO: BUTLER]\ninstall stable diffusion for me");
  assert(p.tag === "BUTLER", "[TO: BUTLER] -> BUTLER (was silently becoming USER before)");
  assert(p.body === "install stable diffusion for me", "the [TO: BUTLER] tag is stripped from the body, not left in it");
  assert(e.parseRoundtableTag("[to:butler] hey").tag === "BUTLER", "case/spacing-insensitive");
}

function testEndTagCompletion() {
  console.log("\n== findEndTag / parseEndTag: the closing tag is the completion signal ==");
  assert(e.hasEndTag("all done here.\n[FROM: CHATGPT]"), "a trailing [FROM: X] completes the message");
  assert(!e.hasEndTag("still typing, no closing tag yet"), "no closing tag -> not complete");
  assert(e.parseEndTag("the answer is 42.\n[FROM: CHATGPT]").body === "the answer is 42.", "the closing tag is stripped from the body");
  assert(e.hasEndTag("The answer is 42. [FROM: CHATGPT]"), "a same-line closing tag still completes (common real output)");
  assert(e.hasEndTag("done [FROM: CHATGPT] thanks!"), "a short sign-off tail after the tag is tolerated");
}

function testQuotedExampleNotTruncated() {
  console.log("\n== E04: a quoted/fenced [FROM: X] EXAMPLE must not be taken as the terminator ==");
  // The exact audit case: a quoted example was treated as the close and truncated
  // everything after it. Now the quoted tag is skipped.
  const quotedOnly = 'Use the format you must end with: "[FROM: CHATGPT]"';
  assert(!e.hasEndTag(quotedOnly), 'a lone quoted "[FROM: X]" example is NOT treated as a real terminator');
  assert(e.parseEndTag(quotedOnly).body === quotedOnly, "so the content (incl. the closing quote) is preserved, not truncated");

  // A quoted example FOLLOWED by a genuine terminator: the real one wins and the
  // middle content survives.
  const withReal = 'The marker looks like "[FROM: CHATGPT]". This sentence must survive.\n[FROM: CHATGPT]';
  assert(e.hasEndTag(withReal), "a genuine terminator after a quoted example is still detected");
  assert(/This sentence must survive\./.test(e.parseEndTag(withReal).body), "the text between the quoted example and the real terminator is not lost");
  assert(/"\[FROM: CHATGPT\]"/.test(e.parseEndTag(withReal).body), "the quoted example itself is preserved verbatim in the body");

  // An inline-code (backtick) example is likewise not a terminator.
  assert(!e.hasEndTag("end your message with `[FROM: CLAUDE]`"), "an inline-code `[FROM: X]` example is not a terminator");

  // A [FROM: X] inside a fenced code block, with the fence still to come, is not
  // the close — the real terminator is the standalone one after the fence.
  const fenced = "here's code:\n```\nprint(\"[FROM: GEMINI]\")\n```\n[FROM: GEMINI]";
  assert(e.hasEndTag(fenced), "a fenced example doesn't stop detection of the real terminator");
  assert(/```/.test(e.parseEndTag(fenced).body), "the closing code fence is preserved in the body (not truncated away)");
}

function testNoneAndStrip() {
  console.log("\n== isNoneSkip + stripEnvelope ==");
  assert(e.isNoneSkip("[TO: NONE]"), "[TO: NONE] is a skip");
  assert(e.isNoneSkip("**NONE**"), "a bare formatted NONE is a skip");
  assert(!e.isNoneSkip("None of this works for me"), '"None of this works" is a real message, not a skip');
  assert(e.stripEnvelope("[TO: GEMINI]\nthe middle\n[FROM: CHATGPT]") === "the middle", "stripEnvelope removes both the [TO:] and [FROM:] tags");
}

function main() {
  testRoutingTag();
  testButlerDestination();
  testEndTagCompletion();
  testQuotedExampleNotTruncated();
  testNoneAndStrip();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
