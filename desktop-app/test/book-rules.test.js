// test/book-rules.test.js — the 3-AI Rules of Conduct ("bible") module.
// Run: node test/book-rules.test.js
const rules = require("../book-rules");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

function main() {
  console.log("\n== the rules text carries the whole protocol ==");
  assert(typeof rules.RULES_TEXT === "string" && rules.RULES_TEXT.length > 10000,
    `RULES_TEXT is embedded (${rules.RULES_TEXT.length} chars)`);
  assert(rules.RULES_VERSION === "v1.1", "a version is declared (for the manual-resend log + rule versioning)");
  // Spot-check the key governance pillars survived extraction/cleaning.
  for (const needle of [
    "CORE OPERATING RULE", "USER AUTHORITY", "CHATGPT AUTHORITY", "GEMINI AUTHORITY",
    "CLAUDE AUTHORITY", "THREE-AI MAJORITY VOTING", "VOTE-TO-EVOLVE", "FINAL OPERATING PRINCIPLE",
  ]) {
    assert(rules.RULES_TEXT.includes(needle), `the protocol still contains "${needle}"`);
  }
  // Page furniture must be gone (we send the AIs the rules, not PDF cruft).
  assert(!/\bPAGE \d+\b/.test(rules.RULES_TEXT), "PDF page-number furniture was stripped");
  assert(!/TABLE OF CONTENTS/.test(rules.RULES_TEXT), "the table of contents was stripped");

  console.log("\n== the communication envelope (v1.1) is taught ==");
  assert(rules.RULES_TEXT.includes("COMMUNICATION ENVELOPE"), "the rules teach the mandatory [TO:]/[FROM:] envelope");
  assert(/\[FROM:/.test(rules.RULES_TEXT) && /\[TO:/.test(rules.RULES_TEXT), "both the routing tag and the closing tag are documented");
  assert(typeof rules.composeEnvelopeReminder === "function", "a missing-tag reminder composer is exported");
  assert(/NONE is a complete message/i.test(rules.RULES_TEXT), "the envelope rule documents NONE as the exception that needs no [FROM:] tag");
  const reminder = rules.composeEnvelopeReminder("claude");
  assert(/\[FROM: CLAUDE\]/.test(reminder), "the reminder fills in the specific AI's own closing tag");
  assert(/discard|not delivered|resend/i.test(reminder), "the reminder says the message was lost and must be resent");

  console.log("\n== the sent message frames it as the bible + no-ack ==");
  const msg = rules.composeRulesMessage();
  assert(msg.includes(rules.RULES_TEXT), "the message carries the full rules text");
  assert(/RULES OF CONDUCT/i.test(msg) && /bible/i.test(msg), "the message names it as their governing bible");
  assert(/do not reply to acknowledge|no acknowledgment|do not restate/i.test(msg),
    "the framing tells them NOT to acknowledge/restate (Rules 9 & 23) — a repeat send is a reminder, not a new ask");
  assert(/ChatGPT = Story|Story \/ Project Lead/i.test(msg) && /Gemini = Canon|Canon \/ Planning/i.test(msg) && /Claude = Author|Author \/ Writing/i.test(msg),
    "the framing states each AI's role");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
