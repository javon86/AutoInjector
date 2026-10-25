// test/akowe-tab.test.js — the 📖 Akọwe tab in controls.html/controls.js (one app, one launcher):
// switching tabs tells main where the Akọwe view goes, and each server phase shows the right
// plain-words notice and buttons (Get Python / Try again / Open log / Bring back / Start now).
// jsdom, with a stub window.api. Run with: node test/akowe-tab.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeApi(initial) {
  const calls = [];
  const cbs = {};
  let status = initial;
  const known = {
    getState: async () => ({}),
    akoweServerStatus: async () => { calls.push(["status"]); return status; },
    akoweServerRetry: async () => { calls.push(["retry"]); status = Object.assign({}, status, { phase: "checking", error: null, message: "Looking for a running Akọwe…" }); return status; },
    akoweServerOpenLog: async () => { calls.push(["openLog"]); return { ok: true }; },
    akoweServerGetPython: async () => { calls.push(["getPython"]); return { ok: true }; },
    akoweServerSetAutostart: async (on) => { calls.push(["autostart", on]); status = Object.assign({}, status, { startWithApp: on }); return status; },
    akoweTab: async (active) => { calls.push(["tab", active]); return status; },
    akoweReload: async () => { calls.push(["reload"]); return status; },
    akowePopOut: async () => { calls.push(["popout"]); status = Object.assign({}, status, { view: { popped: true, loaded: true } }); return { ok: true, status }; },
    akoweDock: async () => { calls.push(["dock"]); status = Object.assign({}, status, { view: { popped: false, loaded: true } }); return { ok: true, status }; },
    onAkoweServer: (cb) => { cbs.server = cb; },
    onAkoweTabShow: (cb) => { cbs.tabShow = cb; },
  };
  // Everything else controls.js calls at load: on* listeners are kept, the rest answer {}.
  const api = new Proxy(known, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string" && /^on[A-Z]/.test(k)) return () => {};
      return async () => ({});
    },
  });
  return { api, calls, cbs, push: (st) => { status = st; cbs.server && cbs.server(st); } };
}
async function load(initial) {
  const html = fs.readFileSync(path.join(__dirname, "..", "controls.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/controls.html" });
  const h = makeApi(initial);
  dom.window.api = h.api;
  dom.window.confirm = () => true;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8"));
  await tick(30);
  return Object.assign(h, { dom, doc: dom.window.document, click: (id) => dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event("click", { bubbles: true })) });
}
const base = { enabled: true, startWithApp: true, view: { popped: false, loaded: false }, pythonDownloadUrl: "https://www.python.org/downloads/" };

(async () => {
  console.log("== the two tabs ==");
  {
    const t = await load(Object.assign({}, base, { phase: "starting", message: "Starting Akọwe…" }));
    const d = t.doc;
    assert(d.getElementById("tab-app-main").getAttribute("aria-selected") === "true" && d.getElementById("akowe-tab").hidden, "starts on 🤖 AutoInjector, the Akọwe tab hidden");
    t.click("tab-app-akowe");
    assert(d.body.dataset.appTab === "akowe" && !d.getElementById("akowe-tab").hidden && d.getElementById("tab-app-akowe").getAttribute("aria-selected") === "true", "📖 Akọwe shows its tab (and hides the rest via CSS)");
    assert(t.calls.some((c) => c[0] === "tab" && c[1] === true), "main is told the Akọwe tab is showing (to lay the view over it)");
    assert(/Starting Akọwe/.test(d.getElementById("akowe-notice-title").textContent), "while starting: “Starting Akọwe…”");
    assert(d.getElementById("akowe-tab-dot").dataset.tone === "busy", "the tab dot pulses amber");
    t.click("tab-app-main");
    assert(d.body.dataset.appTab === "main" && t.calls.some((c) => c[0] === "tab" && c[1] === false), "back to 🤖 AutoInjector hides the view");
    t.cbs.tabShow();
    assert(d.body.dataset.appTab === "akowe", "“Open Akọwe” from the panel switches to the Akọwe tab");
  }

  console.log("\n== Python missing ==");
  {
    const t = await load(Object.assign({}, base, { phase: "failed", error: "NO_PYTHON", message: "Akọwe needs Python 3.10 or newer, and it was not found. Install it from https://www.python.org/downloads/ …" }));
    const d = t.doc;
    assert(d.getElementById("akowe-notice-title").textContent === "Akọwe needs Python", "title: Akọwe needs Python");
    assert(/python\.org/.test(d.getElementById("akowe-notice-text").textContent), "says what to install, with the link");
    assert(d.getElementById("btn-akowe-getpython") && d.getElementById("btn-akowe-retry"), "⬇ Get Python and ↻ Try again");
    assert(/works without/.test(d.getElementById("akowe-notice-small").textContent), "and that the rest of AutoInjector works");
    assert(d.getElementById("akowe-tab-dot").dataset.tone === "error", "red dot");
    t.click("btn-akowe-getpython");
    await tick();
    assert(t.calls.some((c) => c[0] === "getPython"), "Get Python opens python.org (via main)");
    t.click("btn-akowe-retry");
    await tick();
    assert(t.calls.some((c) => c[0] === "retry") && /Starting/.test(d.getElementById("akowe-notice-title").textContent), "Try again starts it again");
  }

  console.log("\n== crashed / no answer: Try again + Open log ==");
  {
    const t = await load(Object.assign({}, base, { phase: "failed", error: "HEALTH_TIMEOUT", message: "Akọwe started but did not answer within 60 seconds." }));
    const d = t.doc;
    assert(d.getElementById("akowe-notice-title").textContent === "Akọwe couldn't start", "title: Akọwe couldn't start");
    assert(d.getElementById("btn-akowe-retry") && d.getElementById("btn-akowe-openlog"), "↻ Try again and 📄 Open log");
    t.click("btn-akowe-openlog");
    await tick();
    assert(t.calls.some((c) => c[0] === "openLog"), "Open log asks main to open akowe-server.log");
    t.push(Object.assign({}, base, { phase: "restarting", restarts: 2, message: "Akọwe stopped unexpectedly. Restarting it in 5 s (try 3 of 5)…" }));
    assert(/restarting/i.test(d.getElementById("akowe-notice-title").textContent) && /try 3 of 5/.test(d.getElementById("akowe-notice-text").textContent), "restarting shows the try count");
  }

  console.log("\n== running, pop out and back ==");
  {
    const t = await load(Object.assign({}, base, { phase: "running", owned: true, port: 8780, hasToken: true, view: { popped: false, loaded: true } }));
    const d = t.doc;
    assert(/running · port 8780/.test(d.getElementById("akowe-tab-state").textContent), "the bar says Akọwe is running, and where");
    assert(d.getElementById("akowe-tab-dot").dataset.tone === "ok", "green dot");
    assert(!d.getElementById("btn-akowe-popout").disabled && /Pop out/.test(d.getElementById("btn-akowe-popout").textContent), "⇱ Pop out is available");
    t.click("btn-akowe-popout");
    await tick();
    assert(t.calls.some((c) => c[0] === "popout") && /Bring back/.test(d.getElementById("btn-akowe-popout").textContent), "after popping out the button reads ⇲ Bring back");
    assert(/own window/.test(d.getElementById("akowe-notice-title").textContent), "the tab says Akọwe is in its own window");
    t.click("btn-akowe-popout");
    await tick();
    assert(t.calls.some((c) => c[0] === "dock") && /Pop out/.test(d.getElementById("btn-akowe-popout").textContent), "Bring back docks it again");
    t.click("btn-akowe-reload");
    await tick();
    assert(t.calls.some((c) => c[0] === "reload"), "↻ Reload loads the start page again");
  }

  console.log("\n== Start with AutoInjector off ==");
  {
    const t = await load(Object.assign({}, base, { phase: "idle", enabled: false, startWithApp: false }));
    const d = t.doc;
    assert(!d.getElementById("akowe-autostart").checked, "the checkbox shows the setting");
    assert(/doesn't start with AutoInjector/.test(d.getElementById("akowe-notice-title").textContent) && d.getElementById("btn-akowe-start"), "says so, with ▶ Start Akọwe now");
    const cb = d.getElementById("akowe-autostart");
    cb.checked = true;
    cb.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
    await tick();
    assert(t.calls.some((c) => c[0] === "autostart" && c[1] === true), "ticking it saves the setting");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
