#!/usr/bin/env node
// quality-check.js -- a mechanically-rerunnable scorecard: two real numbers
// computed fresh every run, never hardcoded/fabricated. Run with:
//   npm run quality
//
//   1. Aggregate pass/fail across every test file in package.json's `test`
//      script, run as real child processes (not just re-parsed source) --
//      so this reflects the actual current behavior of the code, not a
//      cached or assumed result.
//   2. IPC-handler test coverage: every ipcMain.handle("channel", ...) in
//      main.js vs. every call("channel", ...) reference in test/run.js (the
//      only test file that exercises real ipcMain handlers -- the other six
//      drive renderer JS through a mocked window.api instead, a separate,
//      valid layer of coverage this script doesn't attempt to measure).
//      Computed via plain regex scans of the source, consistent with how
//      this project avoids external test frameworks/dependencies elsewhere.
//
// This intentionally does NOT attempt to produce a single blended "quality
// score" -- two honest, independently-meaningful numbers beat one composite
// that hides which part actually matters. See QUALITY_AUDIT.md for the
// narrative findings this script doesn't (and can't) capture on its own,
// including the one number no script here can produce: real relay
// reliability against actual signed-in ChatGPT/Claude/Gemini panes, which
// only the in-app 🎛️ Tuner can measure.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Kept in sync by hand with package.json's own "test" script -- if that
// script's file list ever changes, update this list too so the aggregate
// stays accurate rather than silently drifting stale.
const TEST_FILES = [
  "test/run.js",
  "test/controls.test.js",
  "test/prompt-editor.test.js",
  "test/document-viewer.test.js",
  "test/prompt-sequence.test.js",
  "test/manager-provider.test.js",
  "test/selectors-sync.test.js"
];
const SUMMARY_RE = /(\d+) passed, (\d+) failed/;

function runTestSuite() {
  let totalPassed = 0;
  let totalFailed = 0;
  const crashed = [];
  for (const file of TEST_FILES) {
    const res = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8" });
    const m = SUMMARY_RE.exec(res.stdout || "");
    if (!m) {
      // Didn't even reach its own summary line -- a hard crash, not a clean
      // 0/0. Counted as a failure so a broken test file can't silently
      // vanish from the aggregate instead of dragging the score down.
      crashed.push({ file, stderr: (res.stderr || "").trim().slice(0, 500) || (res.stdout || "").trim().slice(0, 500) });
      totalFailed += 1;
      continue;
    }
    totalPassed += Number(m[1]);
    totalFailed += Number(m[2]);
  }
  return { totalPassed, totalFailed, crashed };
}

function ipcCoverage() {
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const testSrc = fs.readFileSync(path.join(ROOT, "test", "run.js"), "utf8");

  const channelRe = /ipcMain\.handle\(\s*["'`]([a-zA-Z0-9:_-]+)["'`]/g;
  const channels = new Set();
  let m;
  while ((m = channelRe.exec(mainSrc))) channels.add(m[1]);

  const callRe = /\bcall\(\s*["'`]([a-zA-Z0-9:_-]+)["'`]/g;
  const called = new Set();
  while ((m = callRe.exec(testSrc))) called.add(m[1]);

  const all = [...channels].sort();
  const covered = all.filter((c) => called.has(c));
  const uncovered = all.filter((c) => !called.has(c));
  return {
    total: all.length,
    coveredCount: covered.length,
    percent: all.length ? (covered.length / all.length) * 100 : 0,
    uncovered
  };
}

function main() {
  console.log(`AutoInjector quality check -- ${new Date().toISOString()}\n`);

  console.log("== Test suite ==");
  const { totalPassed, totalFailed, crashed } = runTestSuite();
  console.log(`  ${totalPassed} passed, ${totalFailed} failed across ${TEST_FILES.length} files`);
  for (const c of crashed) {
    console.log(`  CRASHED: ${c.file}`);
    if (c.stderr) console.log(`    ${c.stderr}`);
  }

  console.log("\n== IPC handler test coverage ==");
  const cov = ipcCoverage();
  console.log(`  ${cov.coveredCount}/${cov.total} channels referenced by test/run.js's call() (${cov.percent.toFixed(1)}%)`);
  if (cov.uncovered.length) {
    console.log(`  Uncovered channels (${cov.uncovered.length}):`);
    for (const c of cov.uncovered) console.log(`    - ${c}`);
  }

  console.log("\n== Live relay reliability ==");
  console.log("  Not measurable from here -- this script only checks code-level");
  console.log("  correctness and test coverage. Whether real, signed-in ChatGPT/");
  console.log("  Claude/Gemini panes actually relay to each other right now is a");
  console.log("  separate, genuine number only the in-app 🎛️ Tuner can produce.");

  const ok = totalFailed === 0 && crashed.length === 0;
  console.log(`\n${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main();
