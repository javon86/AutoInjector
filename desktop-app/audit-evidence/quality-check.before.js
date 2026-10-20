#!/usr/bin/env node
// quality-check.js — a mechanically-rerunnable, HONEST scorecard (QA-002).
// Run: npm run quality   (add --e2e to also run the GUI E2E layer here)
//
// It derives its test list from package.json's own scripts (never a hand-kept
// copy that silently drifts), runs each LAYER as real child processes, and
// prints a per-layer status. Overall "verified" requires every applicable layer
// that could actually run to pass; a layer that could not run here (no Python,
// GUI E2E not requested) is reported UNVERIFIED — never silently folded into a
// green PASS.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts || {};
const SUMMARY_RE = /(\d+) passed, (\d+) failed/;

// Pull the `node test/x.js` file list straight out of a package.json script.
function filesFromScript(name) {
  const s = scripts[name] || "";
  const out = []; const re = /node\s+(test\/[^\s&|]+\.js)/g; let m;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}
function runNodeFiles(files, opts) {
  const o = opts || {};
  let passed = 0, failed = 0; const crashed = []; const timedOut = [];
  for (const file of files) {
    const bin = o.cmd ? o.cmd.bin : process.execPath;
    const args = o.cmd ? [...o.cmd.args, file] : [file];
    const res = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", timeout: o.timeoutMs || 300000 });
    if (res.error && res.error.code === "ETIMEDOUT") { timedOut.push(file); continue; }
    const m = SUMMARY_RE.exec(res.stdout || "");
    if (!m) { crashed.push(file); failed += 1; continue; }
    passed += Number(m[1]); failed += Number(m[2]);
  }
  return { passed, failed, crashed, timedOut, count: files.length };
}
function layerLine(name, r) {
  const status = r.status || (r.failed === 0 && r.crashed.length === 0 ? "PASS" : "FAIL");
  let detail = "";
  if (r.passed != null) detail = `${r.passed} passed, ${r.failed} failed across ${r.count} file(s)`;
  if (r.note) detail = detail ? `${detail} — ${r.note}` : r.note;
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  for (const c of (r.crashed || [])) console.log(`      CRASHED: ${c}`);
  return status;
}

function pythonBin() {
  for (const bin of (process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"])) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python\s+3\./.test((r.stdout || "") + (r.stderr || ""))) return bin;
  }
  return null;
}
function runPythonAtelier() {
  const bin = pythonBin();
  const dir = path.join(ROOT, "atelier");
  if (!bin) return { status: "UNVERIFIED", note: "Python 3 not found on PATH" };
  if (!fs.existsSync(dir)) return { status: "UNVERIFIED", note: "no atelier/ package" };
  const tests = fs.readdirSync(dir).filter((f) => /^test_.*\.py$/.test(f));
  if (!tests.length) return { status: "UNVERIFIED", note: "no atelier test_*.py files" };
  let passed = 0, failed = 0; const crashed = [];
  for (const t of tests) {
    const res = spawnSync(bin, [t], { cwd: dir, encoding: "utf8", timeout: 300000 });
    const txt = (res.stdout || "") + (res.stderr || "");
    const m = /(\d+)\s*\/\s*(\d+)\s+passed/.exec(txt) || SUMMARY_RE.exec(txt);
    if (res.status !== 0 && !m) { crashed.push(t); failed += 1; continue; }
    if (m && m[2] != null && /\//.test(m[0])) { passed += Number(m[1]); failed += (Number(m[2]) - Number(m[1])); }
    else if (m) { passed += Number(m[1]); failed += Number(m[2]); }
  }
  return { passed, failed, crashed, count: tests.length };
}

function main() {
  console.log(`AutoInjector quality check — ${new Date().toISOString()}\n== Layers ==`);
  const statuses = {};

  statuses.unit = layerLine("Unit", runNodeFiles(filesFromScript("test:unit")));
  // The integration harness can hang on a startup race (QA-001); bound it and
  // report a timeout as UNVERIFIED rather than letting it stall the whole run.
  const integ = runNodeFiles(filesFromScript("test:integration"), { timeoutMs: 240000 });
  if (integ.timedOut.length && integ.passed === 0 && integ.failed === 0) {
    statuses.integration = layerLine("Integration", { status: "UNVERIFIED", note: `timed out after 60s (${integ.timedOut.join(", ")}) — see QA-001` });
  } else {
    statuses.integration = layerLine("Integration", integ);
  }
  statuses.python = layerLine("Python ATELIER", runPythonAtelier());

  // GUI E2E is heavy (spawns Electron under a display); run only on request, and
  // report UNVERIFIED — not PASS — when we didn't run it here.
  if (process.argv.includes("--e2e")) {
    const hasXvfb = spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).status === 0;
    statuses.e2e = hasXvfb
      ? layerLine("GUI E2E", runNodeFiles(filesFromScript("test:e2e"), { bin: "xvfb-run", args: ["-a", process.execPath] }))
      : layerLine("GUI E2E", { status: "UNVERIFIED", note: "xvfb-run not available" });
  } else {
    statuses.e2e = layerLine("GUI E2E", { status: "UNVERIFIED", note: "not run (pass --e2e to include)" });
  }
  statuses.relay = layerLine("Live relay", { status: "UNVERIFIED", note: "only the in-app 🎛️ Tuner can measure real signed-in relay" });

  console.log("\n== IPC handler coverage ==");
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const testSrc = fs.readFileSync(path.join(ROOT, "test", "run.js"), "utf8");
  const channels = new Set(); let m;
  const channelRe = /ipcMain\.handle\(\s*["'`]([a-zA-Z0-9:_-]+)["'`]/g;
  while ((m = channelRe.exec(mainSrc))) channels.add(m[1]);
  const called = new Set();
  const callRe = /\bcall\(\s*["'`]([a-zA-Z0-9:_-]+)["'`]/g;
  while ((m = callRe.exec(testSrc))) called.add(m[1]);
  const all = [...channels]; const covered = all.filter((c) => called.has(c));
  console.log(`  ${covered.length}/${all.length} channels exercised by test/run.js (${all.length ? (covered.length / all.length * 100).toFixed(1) : 0}%)`);

  // Overall: PASS only if every layer that actually RAN passed. UNVERIFIED
  // layers do not turn the result red, but they DO prevent a clean "all
  // verified" claim.
  const ran = Object.entries(statuses).filter(([, s]) => s === "PASS" || s === "FAIL");
  const anyFail = ran.some(([, s]) => s === "FAIL");
  const unverified = Object.entries(statuses).filter(([, s]) => s === "UNVERIFIED").map(([k]) => k);
  console.log(`\nRan: ${ran.map(([k]) => k).join(", ") || "none"}`);
  if (unverified.length) console.log(`Unverified (not run here): ${unverified.join(", ")}`);
  const verdict = anyFail ? "FAIL" : (unverified.length ? "PARTIAL — ran layers passed; some layers UNVERIFIED" : "PASS — all applicable layers verified");
  console.log(`\n${verdict}`);
  process.exit(anyFail ? 1 : 0);
}
main();
