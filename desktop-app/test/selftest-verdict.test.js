// test/selftest-verdict.test.js — the connectivity self-test's verdict
// (selftest-verdict.js). Real case from a user's log: Gemini RAN Python to
// reverse the token, so its reply held the original token inside the code and
// the reversed one as output — reported as SELECTOR_TOO_BROAD. Now: that passes,
// while a capture that holds the user's own sent message still fails.
// Run: node test/selftest-verdict.test.js
const v = require("../selftest-verdict");
const { cleanReplyText } = require("../reply-clean");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const rev = (s) => s.split("").reverse().join("");

console.log("\n== (a) the prompt asks for plain text, no code or tools ==");
{
  const p = v.selftestPrompt("AUTOINJ-ABC123");
  assert(/do not run code or use any tools/i.test(p), "the prompt says not to run code or use tools");
  assert(/ONLY the reversed text/.test(p), "the prompt asks for just the reversed text");
  assert(/: AUTOINJ-ABC123$/.test(p), "the token is still the last thing in the prompt");
  assert(p.includes("Reverse the letters of this token"), "the prompt still asks to reverse the token");
}

console.log("\n== (b) Gemini ran code: the real capture passes ==");
{
  const token = "AUTOINJ-UYORFD", r = rev(token);
  const prompt = v.selftestPrompt(token);
  const raw = "Pythontoken = \"AUTOINJ-UYORFD\"\nprint(token[::-1])\n\nCode outputDFROYU-JNIOTUA\n\nDFROYU-JNIOTUA";
  const res = v.classifySelftestReply(raw, token, r, prompt);
  assert(res && res.ok === true && res.ranCode === true, `the raw capture from the log passes (got ${JSON.stringify(res)})`);
  const cleaned = v.classifySelftestReply(cleanReplyText("gemini", raw), token, r, prompt);
  assert(cleaned && cleaned.ok === true, "the cleaned capture passes too");
  const fenced = "```python\ntoken = AUTOINJ-UYORFD\nprint(token[::-1])\n```\nDFROYU-JNIOTUA";
  assert(v.classifySelftestReply(fenced, token, r, prompt).ok === true, "the original inside a ``` fenced block counts as code");
  const single = "s = 'AUTOINJ-UYORFD'\nprint(s[::-1])\nDFROYU-JNIOTUA";
  assert(v.classifySelftestReply(single, token, r, prompt).ok === true, "single-quoted token in code counts as code");
}

console.log("\n== still SELECTOR_TOO_BROAD when the user's own message is captured ==");
{
  const token = "AUTOINJ-K2PQ9Z", r = rev(token);
  const prompt = v.selftestPrompt(token);
  const both = `${prompt}\n${r}`;
  const a = v.classifySelftestReply(both, token, r, prompt);
  assert(a && !a.ok && a.error === "SELECTOR_TOO_BROAD", "the sent prompt + the reply → too broad");
  const codeAndPrompt = `${prompt}\ntoken = "${token}"\nprint(token[::-1])\n${r}`;
  const b = v.classifySelftestReply(codeAndPrompt, token, r, prompt);
  assert(b && !b.ok && b.error === "SELECTOR_TOO_BROAD", "code in the reply does not excuse a capture that also holds the sent message");
  const youSaid = `You said: ${token}\nReversed: ${r}`;
  const c = v.classifySelftestReply(youSaid, token, r, prompt);
  assert(c && !c.ok && c.error === "SELECTOR_TOO_BROAD", "the original as plain text (not code) → too broad");
  const glued = `token = "${token}"\nprint(token[::-1])\nOutput${r}`;
  const d = v.classifySelftestReply(glued, token, r, prompt);
  assert(d && !d.ok && d.error === "SELECTOR_TOO_BROAD", "the reversed token never standing on its own → too broad (conservative)");
}

console.log("\n== the other outcomes are unchanged ==");
{
  const token = "AUTOINJ-ZZZ111", r = rev(token), prompt = v.selftestPrompt(token);
  assert(v.classifySelftestReply(r, token, r, prompt).ok === true && !v.classifySelftestReply(r, token, r, prompt).ranCode, "just the reversed token → ok");
  assert(v.classifySelftestReply(`Here: ${token}`, token, r, prompt).error === "REPLY_ECHO", "only the original → REPLY_ECHO");
  assert(v.classifySelftestReply("something else", token, r, prompt) === null, "neither → nothing decisive yet");
  assert(v.classifySelftestReply("", token, r, prompt) === null && v.classifySelftestReply(null, token, r, prompt) === null, "empty → nothing decisive");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
