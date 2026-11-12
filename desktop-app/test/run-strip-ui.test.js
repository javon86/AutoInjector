// test/run-strip-ui.test.js — ⏳ the book run's progress in AutoInjector's title bar (run-strip-ui.js):
//   * stripOf: book title, step, time left (against the start estimate), finish time; waiting for the user says so
//     plainly ("the clock is paused", no finish time); a finished run says its real time against the estimate for a
//     while; nothing for a stale / cancelled / unknown run
//   * akowe-run.js progressOf: the clock from Akọwe's API (ISO) or the bridge (epoch ms), bounded, loopback links only
//   * the real controls.html + controls.js in jsdom: the button sits in the title bar before 💾 / 📂 / ❓ Help, fills
//     from the status snapshot's runStrip, and a click opens the run window in the 📖 Akọwe tab (akoweOpenUrl)
// Run with: node test/run-strip-ui.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const strip = require("../run-strip-ui");
const runLib = require("../akowe-run");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const NOW = Date.now();
const BASE = "http://127.0.0.1:8780/";

const apiRun = (extra) => Object.assign({ id: "run-1", kind: "autobook", status: "running", state: "working", project_id: "p1", title: "The Salt Road",
  steps_done: 11, steps_total: 22, step_index: 12, step_total: 19, step_label: "Writing chapter 2 of 10", left_s: 6000, total_estimate_s: 15000,
  percent: 40, finish_at: iso(NOW + 6000e3), started_at: iso(NOW - 3600e3), updated_at: iso(NOW) }, extra || {});

(async () => {
  console.log("== stripOf: one plain line ==");
  {
    const s = strip.stripOf(runLib.summarizeRun(apiRun()), { now: NOW, base: BASE });
    assert(/^📖 “The Salt Road” · Step 12 of 19 — Writing chapter 2 of 10 · ⏳ 1 h 40 m left \(estimate at start: 4 h 10 m\) · ends ~\S/.test(s.long), `working: “${s.long}”`);
    assert(/^⏳ 1 h 40 m left · ~\S.* · 12\/19$/.test(s.short), `short line for a narrower window: “${s.short}”`);
    assert(s.pct === 40 && s.tone === "work" && s.url === `${BASE}#/run/run-1`, "40 % of the estimate, blue, opens #/run/run-1");
    assert(/Started /.test(s.tip) && /Click to open the run window/.test(s.tip), "the tooltip has the whole line, when it started and what a click does");

    const w = strip.stripOf(runLib.summarizeRun(apiRun({ status: "paused", state: "needs_decision", needs_decision: true, waiting_since: iso(NOW - 600e3), finish_at: null })), { now: NOW });
    assert(/· ⏸ waiting for you since \S.* — the clock is paused$/.test(w.long) && !/ends/.test(w.long), `waiting for you: “${w.long}”`);
    assert(w.tone === "warn" && /^⏸ Waiting for you · 12\/19$/.test(w.short), `amber; short “${w.short}”`);
    const i = strip.stripOf(runLib.summarizeRun(apiRun({ status: "interrupted", state: "interrupted", finish_at: null })), { now: NOW });
    assert(/stopped when Akọwe closed/.test(i.long), "interrupted: “stopped when Akọwe closed”");

    const done = runLib.summarizeRun(apiRun({ status: "done", state: "done", actual_s: 5 * 3600 + 120, finished_at: iso(NOW - 60e3), left_s: 0, percent: 100 }));
    const d = strip.stripOf(done, { now: NOW, base: BASE });
    assert(d && d.long === "✔ “The Salt Road” finished in 5 h 2 m (estimated 4 h 10 m)" && d.tone === "ok" && d.pct === 100, `finished: “${d && d.long}”`);
    assert(strip.stripOf(done, { now: NOW + 4 * 3600e3 }) === null, "a few hours later the finished line goes");
    assert(strip.stripOf(runLib.summarizeRun(apiRun({ status: "cancelled", state: "cancelled" })), { now: NOW }) === null, "cancelled: no line");
    assert(strip.stripOf(Object.assign(runLib.summarizeRun(apiRun()), { stale: true }), { now: NOW }) === null, "Akọwe not answering (stale): no line that could be wrong");
    // an older Akọwe (no clock): the step numbers only
    const old = strip.stripOf(runLib.summarizeRun({ id: "r0", status: "running", title: "Old", steps: [{ state: "done", title: "A" }, { state: "running", title: "B" }, { state: "pending", title: "C" }] }), { now: NOW });
    assert(old && old.long === "📖 “Old” · Step 2 of 3" && old.pct === 33, `older Akọwe: “${old && old.long}”`);
    assert(strip.durWords(59) === "59 s" && strip.durWords(1500) === "25 m" && strip.durWords(3600) === "1 h", "plain durations");
  }

  console.log("\n== akowe-run.js progressOf: bounded, from the API or the bridge ==");
  {
    const p = runLib.progressOf(apiRun({ run_url: "https://evil.example/x", percent: 400, left_s: -5 }));
    assert(p.percent === 100 && p.left_s === null && p.run_url === null, "percent capped, a negative time dropped, a non-loopback link dropped");
    const b = runLib.progressOf({ finished_at: NOW, actual_s: 10 });
    assert(b.finished_at === iso(NOW - (NOW % 1000)) || /Z$/.test(b.finished_at), "the bridge's epoch-ms time becomes ISO");
    assert(runLib.progressOf({ id: "x", status: "running" }) === null, "no clock: null");
  }

  console.log("\n== the title bar in the real control panel (jsdom) ==");
  {
    const html = fs.readFileSync(path.join(__dirname, "..", "controls.html"), "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/controls.html" });
    const opened = [];
    const known = { getState: async () => ({}), akoweStatus: async () => ({ ok: false }), akoweOpenUrl: async (url) => { opened.push(url); return { ok: true, inApp: true }; } };
    dom.window.api = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === "string" && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
    dom.window.confirm = () => true;
    Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
    dom.window.requestAnimationFrame = (f) => setTimeout(f, 0);
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "run-strip-ui.js"), "utf8"));
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8"));
    const d = dom.window.document;
    const btn = d.getElementById("btn-run-strip");
    const bar = d.getElementById("window-titlebar");
    assert(btn && btn.parentElement === bar && btn.nextElementSibling && btn.nextElementSibling.id === "btn-save-state", "the button is in the title bar, just before 💾 / 📂 / ❓ Help");
    assert(btn.hidden, "no run: hidden");
    const snap = (run) => ({ ok: true, enabled: false, sites: {}, activity: [], connection: {}, connect: {}, app: { running: true, base: BASE }, akowe: null, run: null, runStrip: run });
    const render = async (run) => { dom.window.eval("akoweRender(" + JSON.stringify(snap(run)) + ")"); await tick(); };
    await render(runLib.summarizeRun(apiRun()));
    assert(!btn.hidden && /Step 12 of 19 — Writing chapter 2 of 10 · ⏳ 1 h 40 m left/.test(btn.querySelector(".rsx-long").textContent), `filled from the snapshot even with the panel closed: “${btn.querySelector(".rsx-long").textContent}”`);
    assert(btn.querySelector(".rsx-fill").style.width === "40%" && btn.dataset.tone === "work", "the thin bar: 40 %");
    assert(/Open the run in Akọwe$/.test(btn.getAttribute("aria-label")), "a plain name for screen readers");
    btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await tick(30);
    assert(opened[0] === `${BASE}#/run/run-1`, `a click opens the run window in the Akọwe tab (${opened[0]})`);
    await render(runLib.summarizeRun(apiRun({ status: "done", state: "done", actual_s: 18120, finished_at: iso(NOW - 60e3) })));
    assert(!btn.hidden && btn.dataset.tone === "ok" && /finished in 5 h 2 m \(estimated 4 h 10 m\)/.test(btn.textContent), "finished: the real time against the estimate");
    btn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await tick(30);
    await render(runLib.summarizeRun(apiRun({ status: "done", state: "done", actual_s: 18120, finished_at: iso(NOW - 60e3) })));
    assert(btn.hidden && opened.length === 2, "seen (clicked): the finished line goes");
    await render(null);
    assert(btn.hidden, "no run: hidden again");
    // the CSS lets it shrink like 💾 / 📂 (the real layout at 1280 px: test/e2e/run-strip.e2e.js)
    assert(/#window-titlebar #btn-run-strip \{[^}]*flex:0 1 auto; min-width:0;[^}]*text-overflow:ellipsis/.test(html) && /@media \(max-width:1500px\) \{ #btn-run-strip \.rsx-long \{ display:none; \}/.test(html), "it may shrink (ellipsis) and has a shorter line on narrower windows");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert(pkg.build.files.includes("run-strip-ui.js"), "run-strip-ui.js is packaged");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
