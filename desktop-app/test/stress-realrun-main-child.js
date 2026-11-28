// test/stress-realrun-main-child.js — part 2 of test/stress-realrun.test.js (section R-D), run in its own process by
// it (main.js is a singleton): the REAL main.js under mock Electron, ChatGPT's pane a fake page (test/fake-dom.js)
// on which main.js's REAL read script, check-in and page-search scripts run. Only the send script and the AI are
// faked (a send appends the message; the AI answers a moment later). Date.now is shifted to step over main.js's
// "never retire a selector set in the last hour" rule. Prints one line: CHILD_RESULT <json>. Not run on its own.
"use strict";
const path = require("path");
const fs = require("fs");
Object.assign(process.env, {
  AUTOINJECTOR_POLL_MS: "50", AUTOINJECTOR_SAVE_DEBOUNCE_MS: "30", AUTOINJECTOR_CAPTURE_SETTLE_MS: "100", AUTOINJECTOR_STABLE_MS: "80",
  AUTOINJECTOR_NOTAG_QUIET_MS: "400", AUTOINJECTOR_BRIDGE: "0", AUTOINJECTOR_CHECKIN: "1", AUTOINJECTOR_STALL_MS: "1500",
  AUTOINJECTOR_CHECKIN_TICK_MS: "200", AUTOINJECTOR_CHECKIN_OWED_DEMAND_MS: "600", AUTOINJECTOR_CHECKIN_OWED_MS: "900", AUTOINJECTOR_CHECKIN_USER_IDLE_MS: "100",
  AUTOINJECTOR_PROBE_TIMEOUT_MS: "2500", AUTOINJECTOR_PROBE_SEND_TIMEOUT_MS: "3000", AUTOINJECTOR_PROBE_EARLY_MS: "400", AUTOINJECTOR_RELOAD_SETTLE_MS: "50",
  AUTOINJECTOR_PROBE_DELAY_MS: "600000", AUTOINJECTOR_RETRY_BACKOFF_MS: "50",
  AUTOINJECTOR_AKOWE_PORT: String(20000 + Math.floor(Math.random() * 20000))
});
process.env.AUTOINJECTOR_AKOWE_DIR = path.join(require("os").tmpdir(), "rd-no-akowe-" + process.pid);
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) { if (request === "electron") return require(mockElectronPath); return originalLoad.apply(this, arguments); };
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {} };
mockElectron.clipboard = { writeText: () => {} };
const { parseHTML, runScript, append } = require("./fake-dom");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, t = 8000) { const s = realNow(); while (realNow() - s < t) { const r = await fn(); if (r) return r; await sleep(25); } return null; }
const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
const reg = (s) => mockElectron.__registry[s];
function cfgOf(script) { const i = script.indexOf("const CFG = "); if (i < 0) return null; const e = script.indexOf(";\n", i); try { return JSON.parse(script.slice(i + 12, e)); } catch (_) { return null; } }
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function main() {
  const userData = mockElectron.app.getPath("userData");
  const H = 3600e3;
  fs.writeFileSync(path.join(userData, "autoinjector-state.json"), JSON.stringify({
    schemaVersion: 1, savedAt: Date.now() - H,
    // the reader ChatGPT's page search learned earlier in the day (as in the log): one block of a reply
    learnedSelectors: { version: 1, sites: { chatgpt: { assistant: { selector: "div.prose-block", how: "page-search", learnedAt: Date.now() - 2 * H, version: 1 } } } }
  }));
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && mockElectron.__ipcHandlers["selfrepair:status"]);
  // ChatGPT's page: a turn per message; a reply is split into one block per paragraph; a check-in answer is one block
  const doc = parseHTML(`<main><div id="thread"></div><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div><button data-testid="send-button" aria-label="Send prompt">Send</button></form></main>`, { url: "https://chatgpt.com/c/abc" });
  const th = () => doc.getElementById("thread");
  let n = 0;
  const cw = reg("chatgpt").webContents;
  cw.evaluator = async (script) => {
    if (script.includes("typeByKeyboard")) {
      const cfg = cfgOf(script) || {};
      const text = String(cfg.text || "");
      append(doc, th(), `<section class="turn"><div class="user-text">${esc(text)}</div></section>`);
      const w = /Reply with only this word: ([a-z]+)/.exec(text);
      setTimeout(() => {
        if (w) append(doc, th(), `<section class="turn"><div class="prose-block">[TO: USER]\n${w[1]}\n[FROM: CHATGPT]</div></section>`);
        else { const q = /question (\d+)/g; let m, k = null; while ((m = q.exec(text))) k = m[1]; n = k || "x"; append(doc, th(), `<section class="turn"><div class="prose-block">[TO: USER]\nAnswer ${n}, part one.</div><div class="prose-block">Answer ${n}, part two.</div><div class="prose-block">Answer ${n}, part three.\n[FROM: CHATGPT]</div></section>`); }
      }, 60);
      return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0 };
    }
    try { return await runScript(script, doc); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  };
  // Claude and Gemini: plain pages that always answer (their own check-ins pass)
  for (const s of ["claude", "gemini"]) {
    const w = reg(s).webContents;
    w.evaluator = async (script) => {
      if (script.includes("typeByKeyboard")) { const t = String((cfgOf(script) || {}).text || ""); const m = /Reply with only this word: ([a-z]+)/.exec(t); setTimeout(() => { w.currentText = `[TO: USER]\n${m ? m[1] : "ok"}\n[FROM: ${s.toUpperCase()}]`; }, 40); return { ok: true, method: "click", verified: true, proof: "number", markerBaseline: 0 }; }
      return { ok: true, text: w.currentText || "", generating: false, sendReady: true, inputFound: true };
    };
  }
  const logLines = (kind) => { let t = ""; try { t = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8"); } catch (_) {} return t.split("\n").filter((l) => l.includes(`"kind":"${kind}"`)).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); };
  const transcriptHas = async (re) => (await call("state:get")).transcript.some((t) => t.site === "chatgpt" && re.test(t.text));
  await sleep(800); // start-up check-ins settle
  const out = { cycles: [], startLearned: "div.prose-block" };
  let replyNo = 0;
  for (let cycle = 1; cycle <= 2; cycle++) {
    const c = { cycle, captured: 0, fragments: 0, retiredAfter: null, lostReply: null, stallMs: null, relearnMs: null, relearned: null, recoveredLostReply: false };
    const retiredBefore = logLines("selector-retired").length;
    c.stalls0 = logLines("capture-stalled").filter((l) => l.detail && l.detail.site === "chatgpt").length;
    c.learned0 = logLines("selector-learned").filter((l) => l.detail && l.detail.site === "chatgpt").length;
    for (let i = 0; i < 4; i++) {
      replyNo++;
      await call("send:compose", { text: `question ${replyNo}`, targets: ["chatgpt"] });
      const got = await waitUntil(() => transcriptHas(new RegExp(`Answer ${replyNo}, part one`)), 2500);
      if (got) { c.captured++; continue; }
      if (logLines("selector-retired").length > retiredBefore) {
        // the reader was retired: this reply is not read; time the stall and the re-learn
        const t0 = realNow();
        c.lostReply = replyNo;
        c.retiredAfter = c.captured;
        const stalls0 = c.stalls0;
        const st = await waitUntil(() => logLines("capture-stalled").filter((l) => l.detail && l.detail.site === "chatgpt").length > stalls0, 8000);
        c.stallMs = st ? realNow() - t0 : null;
        const lr = await waitUntil(() => logLines("selector-learned").filter((l) => l.detail && l.detail.site === "chatgpt").length > c.learned0, 15000);
        c.relearnMs = lr ? realNow() - t0 : null;
        const learnedNow = logLines("selector-learned").filter((l) => l.detail && l.detail.site === "chatgpt").pop();
        c.relearned = learnedNow && learnedNow.detail ? learnedNow.detail.selector || null : null;
        c.stallReason = (logLines("capture-stalled").filter((l) => l.detail && l.detail.site === "chatgpt").pop() || {}).detail;
        c.stallReason = c.stallReason ? c.stallReason.reason : null;
        await sleep(1500);
        c.carryOn = logLines("checkin-continue").filter((l) => l.detail && l.detail.site === "chatgpt").slice(-1).map((l) => ({ sent: l.detail.sent, resent: l.detail.resent }))[0] || null;
        c.recoveredLostReply = await transcriptHas(new RegExp(`Answer ${replyNo}, part one`));
        break;
      }
    }
    c.fragmentLogs = logLines("reply-selector-fragment").length;
    c.retiredLog = logLines("selector-retired").slice(retiredBefore).map((l) => l.detail && { selector: l.detail.selector, source: l.detail.source, after: l.detail.after, starts: l.detail.starts });
    c.staleSeen = logLines("selector-stale-seen").map((l) => l.detail && { selector: l.detail.selector, kind: l.detail.kind, starts: l.detail.starts });
    out.cycles.push(c);
    shift += 61 * 60000; // an hour later (the re-learned reader may then be retired again)
  }
  const st = await call("selfrepair:status");
  out.finalLearned = st.sites.chatgpt.learned && st.sites.chatgpt.learned.assistant ? st.sites.chatgpt.learned.assistant.selector || st.sites.chatgpt.learned.assistant : null;
  out.finalState = st.sites.chatgpt.state;
  if (process.env.RD_DEBUG) { let t = ""; try { t = fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8"); } catch (_) {} console.log(t.split("\n").filter((l) => /chatgpt/.test(l) && /capture-stalled|self-repair|selector-|reply-selector|captured|"sent"/.test(l)).map((l) => l.slice(0, 260)).join("\n")); }
  console.log("CHILD_RESULT " + JSON.stringify(out));
  process.exit(0);
}
setTimeout(() => { console.log("CHILD_RESULT " + JSON.stringify({ error: "child timed out" })); process.exit(1); }, 120000).unref();
main().catch((e) => { console.log("CHILD_RESULT " + JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
