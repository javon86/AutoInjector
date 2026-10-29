// test/akowe-run.test.js — PC test problem 4 (AutoInjector side): the 📚 Akọwe panel showed "10/10 Done" for
// "The Lamplighter's Last Ferry" although its "Make a book for me" run had stopped at step 7 of 16 when Akọwe
// closed mid-run — the bar tracked the book CHECKLIST, not the run. akowe-run.js reads the run itself
// (GET /api/autobook) and the panel shows its real state: "Stopped when Akọwe closed — step 7 of 16 — ▶ Resume",
// then "Writing", then "Finished".
// Run with: node test/akowe-run.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const runLib = require("../akowe-run");
const bridgeMod = require("../akowe-bridge");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// 16 run steps (Akọwe's autobook STEPS), the first `done` done (skipped counts as finished), the next one `cur`.
function steps(done, cur) {
  const titles = ["Safety backup", "Invent the book", "Characters and places", "Character sheets and voices", "Story rules and world texture", "Premise", "Main plot", "Chapter outline", "Write every chapter", "Planned details on the page", "Book format", "Put the book together", "Export PDF, EPUB and Word", "Content check", "Book report", "Beta reader"];
  return titles.map((title, i) => ({ id: `s${i}`, title, state: i < done ? (i === 4 ? "skipped" : "done") : i === done && cur ? cur : "pending" }));
}
const PID = "p-lamp";
const interrupted = { id: "ab-1", kind: "autobook", status: "interrupted", phase: "Interrupted — Akọwe was closed or restarted while this was running. Press Resume.", project_id: PID, title: "The Lamplighter's Last Ferry", steps: steps(6, "running"), updated_at: "2026-10-28T20:07:00Z" };
const running = Object.assign({}, interrupted, { status: "running", phase: "Write every chapter…", steps: steps(8, "running") });
const finished = Object.assign({}, interrupted, { status: "done", phase: "Done", steps: steps(16) });
const needsYou = Object.assign({}, interrupted, { status: "paused", pause_reason: "problem", problem: { record_id: "r-9", message: "The reviewer did not pass chapter 2 after two fixes" }, steps: steps(8, "paused") });

(async () => {
  console.log("== summarizeRun: the run's real state in plain words ==");
  {
    const a = runLib.summarizeRun(interrupted);
    assert(a.state === "interrupted" && a.total === 16 && a.at === 7 && a.done === 6, `interrupted: step 7 of 16 (${a.done} done of ${a.total}, at ${a.at})`);
    assert(/^Stopped when Akọwe closed — step 7 of 16 — ▶ Resume$/.test(a.text), `text: “${a.text}”`);
    assert(a.resumable && a.tone === "warn" && !a.needsDecision, "resumable, amber");
    const w = runLib.summarizeRun(running);
    assert(w.state === "writing" && w.text === "Writing — step 9 of 16" && w.tone === "work" && !w.resumable, `running: “${w.text}”`);
    const f = runLib.summarizeRun(finished);
    assert(f.state === "finished" && f.text === "Finished" && f.done === 16 && f.tone === "ok", "done: “Finished”, 16 of 16");
    const n = runLib.summarizeRun(needsYou);
    assert(n.state === "needs_you" && /needs your decision/.test(n.text) && n.needsDecision && !n.resumable, `paused on a decision: “${n.text}”, no Resume button (the decision stays the author's)`);
    const p = runLib.summarizeRun({ id: "x", status: "paused", pause_reason: "author", steps: steps(3, "paused") });
    assert(p.state === "paused" && /^Paused at step 4 of 16/.test(p.text) && p.resumable, `paused by the author: “${p.text}”`);
    const pushed = runLib.summarizeRun({ id: "x", status: "running", step: 7, steps_total: 16, steps_done: 6 });
    assert(pushed.text === "Writing — step 7 of 16", "a pushed run with only numbers (a newer Akọwe) works too");
    const odd = runLib.summarizeRun({ id: "x", status: "brewing", phase: "Thinking about it" });
    assert(odd.state === "unknown" && odd.text === "Thinking about it", "an unknown status falls back to Akọwe's own words");
    assert(runLib.summarizeRun(null) === null && runLib.summarizeRun("x") === null, "nothing -> null");
  }

  console.log("\n== pickRun: the run of the book on show ==");
  {
    const other = Object.assign({}, finished, { id: "ab-0", project_id: "p-other", updated_at: "2026-10-29T10:00:00Z" });
    assert(runLib.pickRun({ runs: [other, interrupted], active: [] }, PID).id === "ab-1", "the newest run OF THIS BOOK, not the newest overall");
    assert(runLib.pickRun({ runs: [other, interrupted], active: [running] }, PID).status === "running", "a live run wins");
    assert(runLib.pickRun({ runs: [other, interrupted] }, null).id === "ab-0", "no book known: the newest run");
    assert(runLib.pickRun({}, PID) === null, "no runs: null");
  }

  console.log("\n== createRunWatch: refreshed in the background, stale when Akọwe stops answering ==");
  {
    let body = { runs: [interrupted], active: [] };
    let up = true;
    let calls = 0;
    let t = 1000;
    const w = runLib.createRunWatch({ api: async (m, p) => { calls++; assert(m === "GET" && p === "/api/autobook", "reads GET /api/autobook"); return up ? { status: 200, json: body } : { status: 0, json: null, error: "NOT_READY" }; }, now: () => t, minGapMs: 5000 });
    assert(w.peek(PID) === null, "first peek: nothing yet (never waits)");
    await tick();
    assert(w.peek(PID).state === "interrupted" && calls === 1, "after the read: interrupted (one call — no new call within 5 s)");
    body = { runs: [running], active: [running] };
    t += 6000; w.peek(PID); await tick();
    assert(w.peek(PID).state === "writing", "resumed: writing");
    up = false; t += 6000; w.peek(PID); await tick();
    const st = w.peek(PID);
    assert(st.state === "writing" && st.stale === true, "Akọwe closed: the last state is kept, marked stale");
    up = true; body = { runs: [finished], active: [] }; t += 6000;
    const fin = await w.refresh(PID);
    assert(fin.state === "finished" && !w.peek(PID).stale, "finished: “Finished”, not stale");
    const pushed = w.peek(PID, { id: "ab-2", status: "running", project_id: PID, step: 2, steps_total: 16 });
    assert(pushed.id === "ab-2" && pushed.text === "Writing — step 2 of 16", "a live run Akọwe pushes itself wins over an older finished one");
  }

  console.log("\n== the bridge keeps a pushed run (whitelisted) ==");
  {
    const r = bridgeMod.sanitizeAkoweStatus({ app: "akowe", version: 1, checklist: [], run: { id: "ab-1", status: "interrupted", step: 7, steps_total: 16, steps_done: 6, title: "T", secret: "x" } });
    assert(r.ok && r.value.run && r.value.run.status === "interrupted" && r.value.run.steps_total === 16 && !("secret" in r.value.run), "run: id/status/step numbers kept, anything else dropped");
    const n = bridgeMod.sanitizeAkoweStatus({ app: "akowe", version: 1, checklist: [] });
    assert(n.ok && n.value.run === null, "no run pushed -> null");
  }

  console.log("\n== the 📚 panel: the run, not the 10/10 checklist ==");
  {
    const checklist = ["profile", "canon", "premise", "plot", "outline", "chapters", "format", "assemble", "export", "check"].map((id) => ({ id, title: id, set: "B", state: "done" }));
    const snap = (run) => ({
      ok: true, enabled: true, listening: true, port: 17891, now: Date.now(), sites: {}, activity: [], connection: { connected: true }, connect: { phase: "connected" },
      lastExternalContactAt: Date.now(), app: { running: true, base: "http://127.0.0.1:8780/" },
      akowe: { app: "akowe", receivedAt: Date.now(), age_ms: 0, stale: false, akowe_url: "http://127.0.0.1:8780/", project: { id: PID, title: "The Lamplighter's Last Ferry" }, current_task: { title: "All done", state: "done" }, approvals: { count: 0, items: [] }, checklist, done: 10, total: 10 },
      run: run ? runLib.summarizeRun(run) : null,
    });
    let cur = snap(interrupted);
    const resumed = [];
    const html = fs.readFileSync(path.join(__dirname, "..", "controls.html"), "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/controls.html" });
    const known = {
      getState: async () => ({}),
      akoweStatus: async () => cur,
      akoweRunResume: async (id) => { resumed.push(id); cur = snap(running); return { ok: true, message: "Resumed — the book run is writing again.", run: cur.run }; },
    };
    dom.window.api = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === "string" && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
    dom.window.confirm = () => true;
    Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8"));
    const d = dom.window.document;
    const render = async () => { dom.window.eval("akoweRender(" + JSON.stringify(cur) + ")"); await tick(); };
    await render();
    const txt = (id) => (d.getElementById(id) ? d.getElementById(id).textContent : "");
    assert(txt("bf-progress-text") === "6/16", `progress follows the run: “${txt("bf-progress-text")}” (was “10/10” from the checklist)`);
    assert(!d.getElementById("bf-run").hidden && /Stopped when Akọwe closed — step 7 of 16/.test(txt("bf-run-text")), `run line: “${txt("bf-run-text")}”`);
    assert(d.getElementById("bf-run").dataset.tone === "warn", "amber, not “Done” green");
    assert(!d.getElementById("btn-bf-run-resume").hidden, "▶ Resume is offered");
    assert(/Stopped when Akọwe closed/.test(txt("bf-slim-step")), `the slim bar says it too: “${txt("bf-slim-step")}”`);
    d.getElementById("btn-bf-run-resume").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await tick(30);
    assert(resumed[0] === "ab-1", "▶ Resume asks main to resume run ab-1");
    assert(/Writing — step 9 of 16/.test(txt("bf-run-text")) && d.getElementById("btn-bf-run-resume").hidden, `after Resume: “${txt("bf-run-text")}”, no Resume button`);
    cur = snap(needsYou); await render();
    assert(/needs your decision/.test(txt("bf-run-text")) && d.getElementById("btn-bf-run-resume").hidden && !d.getElementById("btn-bf-run-decide").hidden, "a decision: “Decide in Akọwe”, no Resume");
    cur = snap(finished); await render();
    assert(txt("bf-run-text") === "Finished" && txt("bf-progress-text") === "16/16" && d.getElementById("bf-run").dataset.tone === "ok", "finished: “Finished”, 16/16, green");
    cur = snap(null); await render();
    assert(d.getElementById("bf-run").hidden && txt("bf-progress-text") === "10/10", "no run: the checklist as before");
    assert(!/couldn't update/.test(txt("bf-msg")), "no panel error");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
