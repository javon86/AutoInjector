// test/model-tip-ui.test.js — controls.html/controls.js (jsdom): the 💡 "pick the strongest model" tip by the AIs
// shows until the user hides it (remembered), and the "and for every new book" fresh-chat box calls the setting.
// Run with: node test/model-tip-ui.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function load(store) {
  const calls = [];
  const known = {
    getState: async () => ({}),
    freshChatSettings: async (p) => { calls.push(["freshChatSettings", p]); return { ok: true, freshChat: Object.assign({ everyRequests: 15, everyChars: 300000, newBook: true }, p) }; },
  };
  const api = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === "string" && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
  const html = fs.readFileSync(path.join(__dirname, "..", "controls.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/controls.html" });
  for (const [k, v] of Object.entries(store || {})) dom.window.localStorage.setItem(k, v);
  dom.window.api = api;
  dom.window.confirm = () => true;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8"));
  await tick(30);
  return { dom, doc: dom.window.document, calls };
}

(async () => {
  console.log("== 💡 the strongest-model tip ==");
  let t = await load();
  const tip = t.doc.getElementById("bf-model-tip");
  assert(tip && !tip.hidden && /pick the strongest model in each AI window \(ChatGPT, Claude, Gemini\) before you start/.test(tip.textContent) && /thinking/.test(tip.textContent), "shows by the AIs, in plain words");
  t.doc.getElementById("bf-model-tip-x").dispatchEvent(new t.dom.window.Event("click", { bubbles: true }));
  assert(tip.hidden, "✕ hides it");
  assert(t.dom.window.localStorage.getItem("modelTipHidden") === "1", "…and that is remembered");
  t = await load({ modelTipHidden: "1" });
  assert(t.doc.getElementById("bf-model-tip").hidden, "hidden again on the next start");

  console.log("\n== 🆕 fresh chat for every new book ==");
  t = await load();
  const box = t.doc.getElementById("bf-fresh-newbook");
  assert(box && box.checked, "the box is there, ticked (on by default)");
  box.checked = false;
  box.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
  await tick(20);
  assert(t.calls.some((c) => c[0] === "freshChatSettings" && c[1] && c[1].newBook === false), "unticking switches it off");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
