// test/cli-mode.test.js — ⌨ Command-line mode (try it first), AutoInjector's side:
//   * cli-mode-watch.js: Akọwe's /api/cli-mode cleaned and bounded; at most one read per gap; the exchanges are
//     collected piece by piece (?after=) and start over when Akọwe restarted; "Web window / Command line" and the
//     preset go to Akọwe (PUT /api/slots/<id>, POST /api/cli-mode/preset); which panes are on the command line
//   * cli-mode-ui.js: the card's rows, the conversation (newest first), the pane status card
//   * the real controls.html + controls.js in jsdom: the card in the 📚 Akọwe panel, the select calls the API, the
//     preset button, the pane of a command-line AI shows a status card instead of the website
//   * ease.js: the ✅ setup checklist row; a command-line AI's web window is not "needed" any more
//   * main.js wiring: the pane of a command-line AI is moved out of sight; the IPC handlers exist; packaged
// Run with: node test/cli-mode.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const W = require("../cli-mode-watch");
const UI = require("../cli-mode-ui");
const ease = require("../ease");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const apiJson = (extra) => Object.assign({
  slots: [{ slot_id: "AI-1", site: "claude", adapter_id: "autoinjector", mode: "cli", cli: true, can_cli: true },
    { slot_id: "AI-2", site: "chatgpt", adapter_id: "autoinjector", mode: "cli", cli: true, can_cli: true },
    { slot_id: "AI-3", site: null, adapter_id: "none", mode: "web", cli: false, can_cli: false }],
  tools: { claude: { state: "ready", words: "✔ Claude Code 2.1.300 found, signed in", version: "2.1.300" },
    codex: { state: "signed_out", words: "Signed out: press “⌨ Open Codex” and sign in", version: "0.167.2" } },
  exchanges: [{ id: 1, at: 1700000000, slot_id: "AI-1", site: "claude", tool: "claude", task: "Write chapter 1", answer: "{\"title\": \"x\"}", outcome: "ok", seconds: 12.3 },
    { id: 2, at: 1700000060, slot_id: "AI-2", site: "chatgpt", tool: "codex", task: "Review chapter 1", answer: "", outcome: "NOT_LOGGED_IN", seconds: 1 }],
  last_id: 2, running: 1,
}, extra || {});

(async () => {
  console.log("== cli-mode-watch.js ==");
  {
    const v = W.viewOf(apiJson({ slots: [{ slot_id: "AI-1", site: "claude", cli: true, can_cli: true }, { slot_id: "AI-9", site: "x" }, { slot_id: "AI-3", site: "gemini", cli: true, can_cli: true }],
      exchanges: [{ id: 1, task: "a\u0000b".padEnd(900, "x"), answer: "y".repeat(5000), site: "evil", tool: "rm -rf" }] }));
    assert(v.slots.length === 2 && v.slots[0].cli && !v.slots[1].cli && !v.slots[1].can_cli, "slots cleaned: no AI-9; Gemini is never on the command line here");
    assert(v.exchanges[0].task.length <= 260 && !/\u0000/.test(v.exchanges[0].task) && v.exchanges[0].answer.length === 1500 && v.exchanges[0].site === null && v.exchanges[0].tool === "claude", "exchanges bounded and cleaned");
    assert(W.viewOf(null) === null && W.viewOf({ slots: "x" }) === null, "not an answer: null");
    assert([...W.cliSitesOf(W.viewOf(apiJson()))].sort().join() === "chatgpt,claude", "which panes are on the command line");

    let t = 1000;
    const calls = [];
    let reply = apiJson();
    const api = async (m, p, b) => { calls.push([m, p, b]); if (m === "GET") return { status: 200, json: reply }; if (p === "/api/cli-mode/preset") return { status: 200, json: apiJson({ exchanges: [] }) }; if (p === "/api/slots/AI-2") return { status: 200, json: {} }; return { status: 409, json: { errors: [{ code: "INVALID_INPUT", message: "Gemini has no command-line mode yet" }] } }; };
    const w = W.createCliWatch({ api, now: () => t, minGapMs: 4000 });
    assert(w.peek() === null && w.cliSites().size === 0, "nothing known yet: no pane hidden");
    await w.refresh();
    assert(w.peek().exchanges.length === 2 && calls[0][1] === "/api/cli-mode?after=0", "first read: all exchanges");
    await w.refresh();
    assert(calls.length === 1, "at most one read per 4 s");
    t += 5000;
    reply = apiJson({ exchanges: [{ id: 3, site: "claude", tool: "claude", task: "t3", outcome: "ok" }], last_id: 3 });
    await w.refresh();
    assert(calls[1][1] === "/api/cli-mode?after=2" && w.peek().exchanges.map((e) => e.id).join() === "1,2,3", "then only the new ones (?after=2), added to the list");
    t += 5000;
    reply = apiJson({ exchanges: [], last_id: 0 });
    await w.refresh();
    assert(w.peek().exchanges.length === 0, "Akọwe restarted (its last id went back): the list starts over");
    t += 5000;
    reply = apiJson({ exchanges: [{ id: 1, site: "claude", tool: "claude", task: "new", outcome: "ok" }], last_id: 1 });
    await w.refresh();
    assert(calls[calls.length - 1][1] === "/api/cli-mode?after=0" && w.peek().exchanges.length === 1, "…and reads from the start again");
    const r = await w.setMode("AI-2", "web");
    assert(r.ok && calls.some(([m, p, b]) => m === "PUT" && p === "/api/slots/AI-2" && b.mode === "web"), "Web window / Command line is saved in Akọwe (PUT /api/slots/AI-2 {mode})");
    const bad = await w.setMode("AI-3", "cli");
    assert(!bad.ok && /Gemini/.test(bad.message), "Akọwe's refusal comes back in plain words");
    assert(!(await w.setMode("AI-1; rm", "cli")).ok && !(await w.setMode("AI-1", "shell")).ok, "only AI-1..3 and web / cli");
    const pr = await w.preset("two_cli");
    assert(pr.ok && calls.some(([m, p, b]) => m === "POST" && p === "/api/cli-mode/preset" && b.preset === "two_cli"), "the preset goes to Akọwe");
    const down = W.createCliWatch({ api: async () => ({ status: 0, json: null }), now: () => 0 });
    assert((await down.refresh()) === null && down.cliSites().size === 0, "Akọwe not running: nothing mirrored, no pane hidden");
    const throws = W.createCliWatch({ api: async () => { throw new Error("x"); } });
    assert((await throws.refresh()) === null, "never throws");
  }

  console.log("\n== cli-mode-ui.js (plain data) ==");
  {
    const v = W.viewOf(apiJson());
    const m = UI.cardModel(v);
    assert(m.rows.length === 3 && m.rows[0].mode === "cli" && m.rows[0].tone === "ok" && m.rows[1].tone === "warn" && !m.rows[2].canCli, "rows: Claude ok, ChatGPT's Codex signed out (warn), AI-3 not settable");
    assert(/Signed out/.test(m.rows[1].note) && m.isPreset && m.anyCli, "the tool's words on each command-line row; the preset is recognised");
    assert(m.exchanges[0].id === 2 && /signed out/.test(m.exchanges[0].outcome) && m.exchanges[1].outcome === "✔", "the conversation: newest first, outcomes in words");
    const pc = UI.paneCard(v, "claude");
    assert(pc && /Claude is on the command line/.test(pc.title) && /Claude Code/.test(pc.text) && pc.tone === "ok", "the Claude pane's status card");
    assert(UI.paneCard(v, "chatgpt").tone === "warn" && UI.paneCard(v, "gemini") === null, "ChatGPT warns (signed out); Gemini shows its web page");
    assert(UI.cardModel(null) === null && UI.paneCard(null, "claude") === null, "no data: nothing");
    const webOnly = W.viewOf(apiJson({ slots: [{ slot_id: "AI-1", site: "claude", cli: false, can_cli: true }, { slot_id: "AI-3", site: "gemini", can_cli: false }] }));
    const wm = UI.cardModel(webOnly);
    assert(!wm.anyCli && !wm.isPreset && /Gemini yet/.test(wm.rows[1].note), "all web: the preset is offered; Gemini says web window only");
  }

  console.log("\n== the real control panel (jsdom) ==");
  {
    const html = fs.readFileSync(path.join(__dirname, "..", "controls.html"), "utf8");
    assert(/<script src="cli-mode-ui\.js"><\/script>/.test(html) && html.indexOf("cli-mode-ui.js") < html.indexOf('src="run-strip-ui.js"'), "controls.html loads cli-mode-ui.js");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/controls.html" });
    const sent = [];
    const known = {
      getState: async () => ({}), akoweStatus: async () => ({ ok: false }),
      akoweCliSetMode: async (slot, mode) => { sent.push(["mode", slot, mode]); return { ok: true, view: W.viewOf(apiJson({ slots: apiJson().slots.map((s) => (s.slot_id === slot ? Object.assign({}, s, { cli: mode === "cli", mode }) : s)) })) }; },
      akoweCliPreset: async (p) => { sent.push(["preset", p]); return { ok: true, view: W.viewOf(apiJson()) }; },
    };
    dom.window.api = new Proxy(known, { get(t, k) { if (k in t) return t[k]; if (typeof k === "string" && /^on[A-Z]/.test(k)) return () => {}; return async () => ({}); } });
    dom.window.confirm = () => true;
    Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
    dom.window.requestAnimationFrame = (f) => setTimeout(f, 0);
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "cli-mode-ui.js"), "utf8"));
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", "controls.js"), "utf8"));
    const d = dom.window.document;
    // the AI columns (and their pane slots) are built by controls.js; make sure each has one for the test
    for (const site of ["claude", "chatgpt", "gemini"]) if (!d.getElementById(`pane-slot-${site}`)) { const x = d.createElement("div"); x.id = `pane-slot-${site}`; d.body.appendChild(x); }
    const snap = (cli) => ({ ok: true, enabled: false, sites: {}, activity: [], connection: {}, connect: {}, app: { running: true, base: "http://127.0.0.1:8780/" }, akowe: null, run: null, runStrip: null, cliMode: cli });
    const render = async (cli) => { dom.window.eval("akoweRender(" + JSON.stringify(snap(cli)) + ")"); await tick(); };
    await render(null);
    assert(!d.getElementById("cli-card") || d.getElementById("cli-card").hidden, "Akọwe not running: no card");
    await render(W.viewOf(apiJson()));
    const card = d.getElementById("cli-card");
    assert(card && card.parentElement === d.getElementById("akowe-body") && !card.hidden, "the ⌨ Command-line AIs card is in the 📚 Akọwe panel");
    assert(/Command-line AIs \(try it first\)/.test(card.textContent) && /Signed out/.test(card.textContent), "it says which tool is signed in / out");
    const sel = card.querySelector('[data-testid="cli-mode-AI-2"]');
    assert(sel && sel.value === "cli" && !card.querySelector('[data-testid="cli-mode-AI-3"]'), "a Web window / Command line choice per Claude / ChatGPT slot (none for the off slot)");
    const conv = card.querySelector('[data-testid="cli-conv"]');
    assert(conv && /Conversation \(2 answers, 1 working now\)/.test(conv.querySelector("summary").textContent) && /Asked: Review chapter 1/.test(conv.textContent) && /\{"title": "x"\}/.test(conv.textContent), "the conversation: what was asked and the answer");
    assert(!card.querySelector('[data-testid="cli-preset"]') && card.querySelector('[data-testid="cli-preset-web"]'), "already the preset: only “All back to web windows” is offered");
    const pane = d.querySelector('#pane-slot-claude [data-testid="cli-pane-claude"]');
    assert(pane && /Claude is on the command line/.test(pane.textContent) && /Last answer/.test(pane.textContent), "the Claude pane shows a status card instead of the website");
    assert(!d.querySelector('#pane-slot-gemini .cli-pane-card'), "the Gemini pane keeps its website");
    sel.value = "web";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await tick(30);
    assert(sent[0] && sent[0].join() === "mode,AI-2,web", "changing the choice saves it in Akọwe");
    assert(!d.querySelector('#pane-slot-chatgpt .cli-pane-card') && /AI-2 now uses the web window/.test(d.getElementById("cli-card").textContent), "…the ChatGPT pane is the website again, and the card says so");
    await render(W.viewOf(apiJson({ slots: [{ slot_id: "AI-1", site: "claude", cli: false, can_cli: true }, { slot_id: "AI-2", site: "chatgpt", cli: false, can_cli: true }, { slot_id: "AI-3", site: "gemini", cli: false, can_cli: false }], exchanges: [] })));
    const pb = d.querySelector('[data-testid="cli-preset"]');
    assert(pb && /Two AIs: Claude \+ ChatGPT on command line, Gemini off/.test(pb.textContent) && !d.querySelector(".cli-pane-card"), "all web: the preset button, no status cards");
    pb.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await tick(30);
    assert(sent.some((x) => x.join() === "preset,two_cli") && d.querySelectorAll(".cli-pane-card").length === 2, "the preset puts Claude and ChatGPT on the command line (two status cards)");
    assert(!/innerHTML/.test(fs.readFileSync(path.join(__dirname, "..", "cli-mode-ui.js"), "utf8")), "text only (never innerHTML)");
  }

  console.log("\n== ✅ the setup checklist ==");
  {
    const v = W.viewOf(apiJson());
    const it = ease.cliModeItem(v);
    assert(it && it.ok === false && it.group === "optional" && /Codex: Signed out/.test(it.text) && it.fix, "a command-line AI signed out: ❌ with Fix it");
    const ok = ease.cliModeItem(W.viewOf(apiJson({ tools: { claude: { state: "ready", words: "ok" }, codex: { state: "ready", words: "ok" } } })));
    assert(ok.ok === true, "both ready: ✅");
    assert(ease.cliModeItem(W.viewOf(apiJson({ slots: [{ slot_id: "AI-1", site: "claude", cli: false }] }))) === null, "no command-line AI: no row");
    const sites = [{ site: "claude", label: "Claude", active: true, state: "needs_user", problem: "LOGGED_OUT" }, { site: "gemini", label: "Gemini", active: true, state: "ok" }];
    const r = ease.buildChecklist({ sites, cliMode: v, akowe: { phase: "running" } });
    const claudeRow = r.items.find((i) => i.id === "pane-claude");
    assert(claudeRow && claudeRow.group === "optional" && claudeRow.ok === true && /Claude Code on the command line/.test(claudeRow.text), "a command-line AI's web window is not needed for books any more");
    assert(r.items.some((i) => i.id === "cli-mode"), "the command-line row is in the checklist");
    const plain = ease.buildChecklist({ sites, akowe: { phase: "running" } });
    assert(plain.items.find((i) => i.id === "pane-claude").group === "needed" && !plain.items.some((i) => i.id === "cli-mode"), "without command-line AIs: exactly as before");
  }

  console.log("\n== main.js wiring ==");
  {
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(/onCli = cliWatch\.cliSites\(\)\.has\(site\)[\s\S]{0,400}view\.setBounds\(\{ x: -4000, y: 0, width: 800, height: 600 \}\);\s*continue;/.test(main), "a command-line AI's web page moves out of sight (never 0x0)");
    assert(/ipcMain\.handle\("akowe-cli:set-mode"/.test(main) && /ipcMain\.handle\("akowe-cli:preset"/.test(main) && /snap\.cliMode = cliWatch\.peek\(\)/.test(main), "IPC handlers and the snapshot's cliMode");
    const pre = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
    assert(/akoweCliSetMode:/.test(pre) && /akoweCliPreset:/.test(pre), "preload exposes the two calls");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert(pkg.build.files.includes("cli-mode-ui.js") && pkg.build.files.includes("cli-mode-watch.js") && /cli-mode\.test\.js/.test(pkg.scripts["test:unit"]), "packaged and in test:unit");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
