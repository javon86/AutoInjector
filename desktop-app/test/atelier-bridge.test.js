// test/atelier-bridge.test.js — exercises the ATELIER bridge and the opt-in
// governance layer against the REAL vendored Python package (no mocking of the
// gate itself — the whole point is that the shell-out contract holds), plus the
// graceful-degradation path when Python is absent. Run: node test/atelier-bridge.test.js
//
// These tests require python3 on PATH (the same prerequisite ATELIER itself
// has). If none is found they SKIP the live-Python assertions rather than fail,
// so the suite still passes on a machine without Python — which is exactly the
// degradation contract the bridge promises.
const fs = require("fs");
const os = require("os");
const path = require("path");
const bridge = require("../atelier-bridge");
const gov = require("../atelier-governance");

let passed = 0, failed = 0, skipped = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
function skip(msg) { skipped++; console.log(`  skip - ${msg}`); }

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const have = bridge.detect();

function testDetect() {
  console.log("\n== detect(): finds a usable Python 3 or reports why not ==");
  assert(typeof have.available === "boolean", "detect() returns an availability boolean");
  if (have.available) {
    assert(/Python 3\./.test(have.version), `reports the Python 3 version it found (${have.version})`);
    assert(have.python && typeof have.python === "string", "names the interpreter it will use");
  } else {
    assert(typeof have.reason === "string" && have.reason.length > 0, `unavailable, with a reason: ${have.reason}`);
  }
}

function testRoleMapping() {
  console.log("\n== roleFor(): AutoInjector pane ids map onto ATELIER authority roles ==");
  assert(bridge.roleFor("claude") === "claude", "claude -> claude");
  assert(bridge.roleFor("ChatGPT") === "chatgpt", "case-insensitive: ChatGPT -> chatgpt");
  assert(bridge.roleFor("gemini") === "gemini", "gemini -> gemini");
  assert(bridge.roleFor("user") === "human", "operator/user -> human");
  assert(bridge.roleFor("nope") === null, "an unknown pane id maps to null (bridge leaves policy to say deny)");
}

function testAuthorityGate() {
  console.log("\n== checkAuthority(): the write-authority policy is enforced through the shell-out ==");
  if (!have.available) { skip("no Python 3 — authority gate not exercised"); return; }
  const chapter = "04_CHAPTERS/ch01/scenes/s01.md";

  const claudeChapter = bridge.checkAuthority("claude", chapter);
  assert(claudeChapter.available && claudeChapter.ok, "claude MAY write a chapter (matches 04_CHAPTERS/**)");

  const geminiChapter = bridge.checkAuthority("gemini", chapter);
  assert(geminiChapter.available && !geminiChapter.ok, "gemini MAY NOT write a chapter (auditor role) — refused");
  assert(/§3\.3|may not write/.test(geminiChapter.reason), "the refusal carries the policy reason");

  const unknown = bridge.checkAuthority("banana", chapter);
  assert(unknown.available && !unknown.ok, "an unknown role is denied by default");

  const traversal = bridge.checkAuthority("claude", "04_CHAPTERS/../../../etc/passwd");
  assert(traversal.available && !traversal.ok, "a path-traversal escape is refused even though it starts with an allowed prefix");
}

function testStages() {
  console.log("\n== stages(): the ordered, non-skippable pipeline is reported ==");
  if (!have.available) { skip("no Python 3 — stages not exercised"); return; }
  const s = bridge.stages();
  assert(s.available && s.stages[0] === "CREATE" && s.stages[s.stages.length - 1] === "CLOSE",
    `pipeline runs CREATE..CLOSE (${s.stages.length} stages)`);
  assert(s.stages.includes("VERIFY") && s.stages.includes("APPLY"), "includes the VERIFY and APPLY gates");
}

function testDeliver() {
  console.log("\n== deliver(): CREATE->ROUTE->DELIVER routes an authorised reply, refuses an unauthorised one ==");
  if (!have.available) { skip("no Python 3 — deliver not exercised"); return; }
  const proj = tmpDir("atl-proj-");
  try {
    const okRes = bridge.deliver({
      projectDir: proj, jobId: "J1", role: "claude",
      content: "chapter text", target: "04_CHAPTERS/ch01/scenes/s01.md",
    });
    assert(okRes.available && okRes.ok, "a claude reply targeting a chapter is delivered");

    const badRes = bridge.deliver({
      projectDir: proj, jobId: "J2", role: "gemini",
      content: "audit note", target: "04_CHAPTERS/ch01/scenes/s01.md",
    });
    assert(badRes.available && !badRes.ok, "a gemini reply targeting a chapter is REFUSED at ROUTE");

    const redeliver = bridge.deliver({
      projectDir: proj, jobId: "J1", role: "claude",
      content: "different text", target: "04_CHAPTERS/ch01/scenes/s01.md",
    });
    assert(redeliver.available && !redeliver.ok, "re-delivering job J1 with new content is refused (duplicate-delivery guard)");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
}

async function testGovernanceSettings() {
  console.log("\n== governance settings: persist and round-trip ==");
  const dir = tmpDir("atl-gov-");
  try {
    gov.init(dir);
    assert(gov.getSettings().enabled === false, "governance is DISABLED by default");
    gov.setSettings({ enabled: true, projectDir: "/books/salt", targets: { claude: "04_CHAPTERS/ch01/scenes/s01.md" } });
    const s = gov.getSettings();
    assert(s.enabled === true && s.projectDir === "/books/salt", "enabled + projectDir persisted in memory");
    assert(s.targets.claude === "04_CHAPTERS/ch01/scenes/s01.md" && s.targets.gemini === "", "a per-pane target is stored; unset panes stay empty");
    // fresh load from disk
    gov.init(dir);
    assert(gov.getSettings().enabled === true && gov.getSettings().targets.claude.endsWith("s01.md"),
      "settings survive a reload from disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testGovernTurn() {
  console.log("\n== governTurn(): holds an unauthorised reply, passes an authorised one ==");
  const dir = tmpDir("atl-gov2-");
  try {
    gov.init(dir);
    // disabled -> no-op
    let g = await gov.governTurn({ site: "gemini", text: "x" });
    assert(g.governed === false, "when disabled, governTurn is a no-op (governed:false)");

    gov.setSettings({ enabled: true, targets: {
      claude: "04_CHAPTERS/ch01/scenes/s01.md",
      gemini: "04_CHAPTERS/ch01/scenes/s01.md",
    } });

    if (have.available) {
      const claudeTurn = await gov.governTurn({ site: "claude", text: "a chapter" });
      assert(claudeTurn.governed && claudeTurn.ok && !claudeTurn.held, "an authorised claude reply is NOT held");

      const geminiTurn = await gov.governTurn({ site: "gemini", text: "an audit posing as a chapter" });
      assert(geminiTurn.governed && !geminiTurn.ok && geminiTurn.held, "an unauthorised gemini reply IS held");

      const noTarget = await gov.governTurn({ site: "chatgpt", text: "y" });
      assert(noTarget.governed === false, "a pane with no target mapped is passed through (governed:false)");
    } else {
      skip("no Python 3 — live hold/pass decisions not exercised");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testGracefulDegradation() {
  console.log("\n== graceful degradation: a missing Python fails OPEN, never blocking replies ==");
  const dir = tmpDir("atl-gov3-");
  const savedEnv = process.env.ATELIER_PYTHON;
  try {
    process.env.ATELIER_PYTHON = path.join(os.tmpdir(), "definitely-not-a-real-python-xyz");
    const d = bridge.detect({ force: true });
    assert(d.available === false, "detect() reports unavailable when the configured interpreter is missing");

    gov.init(dir);
    gov.setSettings({ enabled: true, targets: { gemini: "04_CHAPTERS/ch01/scenes/s01.md" } });
    const g = await gov.governTurn({ site: "gemini", text: "x" });
    assert(g.governed && g.available === false && g.held === false,
      "with no toolkit, a governed turn is passed through (held:false) rather than blocked");
    assert(typeof g.reason === "string" && g.reason.length > 0, "the reason the toolkit was unavailable is recorded");
  } finally {
    if (savedEnv === undefined) delete process.env.ATELIER_PYTHON; else process.env.ATELIER_PYTHON = savedEnv;
    bridge.detect({ force: true }); // restore the real detection cache for any later suite
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testDetect();
  testRoleMapping();
  testAuthorityGate();
  testStages();
  testDeliver();
  await testGovernanceSettings();
  await testGovernTurn();
  await testGracefulDegradation();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (!have.available) console.log("(Python 3 not found — live-gate assertions were skipped, degradation path still verified)");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("Test runner crashed:", e); process.exit(1); });
