// test/download-manager.test.js — the background download queue.
// Uses a fake runner (no real network) to check concurrency, progress, done,
// and cancel. Run: node test/download-manager.test.js
const dm = require("../download-manager");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}

// A controllable fake runner: each started job exposes finish()/fail() so the
// test drives completion, and records a cancel flag.
function makeControllableRunners(control) {
  return {
    fake: (job, hooks) => {
      control[job.id] = {
        started: true, canceled: false,
        progress: (p, d) => hooks.progress(p, d),
        finish: () => hooks.done(true),
        fail: (e) => hooks.done(false, e),
      };
      return { cancel: () => { control[job.id].canceled = true; } };
    },
  };
}

function testConcurrencyCap() {
  console.log("\n== concurrency: only N jobs run at once; the rest wait ==");
  dm._reset();
  const control = {};
  dm.init({ concurrency: 2, runners: makeControllableRunners(control) });

  const ids = [1, 2, 3, 4].map((n) => dm.enqueue({ kind: "fake", label: `job${n}`, category: "test" }));
  let jobs = dm.list();
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  assert(running.length === 2, "exactly 2 jobs run with a cap of 2");
  assert(queued.length === 2, "the other 2 wait in the queue");

  // Finish one running job -> a queued one should start.
  control[ids[0]].finish();
  jobs = dm.list();
  assert(jobs.find((j) => j.id === ids[0]).status === "done", "finished job is marked done");
  assert(jobs.filter((j) => j.status === "running").length === 2, "a queued job promoted to keep 2 running");
}

function testProgressAndDone() {
  console.log("\n== progress + completion are reported ==");
  dm._reset();
  const control = {};
  dm.init({ concurrency: 1, runners: makeControllableRunners(control) });
  const id = dm.enqueue({ kind: "fake", label: "modelX" });
  control[id].progress(42, "downloading… 42%");
  let job = dm.list().find((j) => j.id === id);
  assert(job.progress === 42 && /42/.test(job.detail), "progress percent + detail flow through");
  control[id].finish();
  job = dm.list().find((j) => j.id === id);
  assert(job.status === "done" && job.progress === 100, "completion sets done + 100%");
}

function testFailureAndUnknownKind() {
  console.log("\n== failures and unknown job types are surfaced, not thrown ==");
  dm._reset();
  const control = {};
  dm.init({ concurrency: 2, runners: makeControllableRunners(control) });
  const id = dm.enqueue({ kind: "fake", label: "willfail" });
  control[id].fail("network died");
  let job = dm.list().find((j) => j.id === id);
  assert(job.status === "failed" && /network died/.test(job.error), "a failed job keeps its error message");

  const bad = dm.enqueue({ kind: "does-not-exist", label: "bogus" });
  job = dm.list().find((j) => j.id === bad);
  assert(job.status === "failed" && /unknown download type/.test(job.error), "an unknown kind fails cleanly");
}

function testCancel() {
  console.log("\n== cancel stops a job and frees a slot ==");
  dm._reset();
  const control = {};
  dm.init({ concurrency: 1, runners: makeControllableRunners(control) });
  const a = dm.enqueue({ kind: "fake", label: "a" });
  const b = dm.enqueue({ kind: "fake", label: "b" });
  assert(dm.list().find((j) => j.id === b).status === "queued", "second job waits behind the cap");
  const ok = dm.cancel(a);
  assert(ok && control[a].canceled === true, "cancel calls the runner's cancel handle");
  const jobs = dm.list();
  assert(jobs.find((j) => j.id === a).status === "canceled", "job a is canceled");
  assert(jobs.find((j) => j.id === b).status === "running", "job b starts once a's slot frees");
}

function testClearFinished() {
  console.log("\n== clearFinished keeps active/queued, drops the rest ==");
  dm._reset();
  const control = {};
  dm.init({ concurrency: 1, runners: makeControllableRunners(control) });
  const a = dm.enqueue({ kind: "fake" });
  const b = dm.enqueue({ kind: "fake" });
  control[a].finish();
  dm.clearFinished();
  const jobs = dm.list();
  assert(!jobs.find((j) => j.id === a), "the finished job is removed");
  assert(jobs.find((j) => j.id === b), "the still-running job stays");
}

testConcurrencyCap();
testProgressAndDone();
testFailureAndUnknownKind();
testCancel();
testClearFinished();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
