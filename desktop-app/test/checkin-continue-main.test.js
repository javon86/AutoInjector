// test/checkin-continue-main.test.js — "carry on after a check-in" inside the REAL
// main.js (mock Electron, see mock-electron.js). The fake AIs here answer a
// check-in with ONLY its word and then stop — like a real AI that has nothing more
// to say. Without the fix the conversation dies there (the 1:03 PM log: Claude
// looked stalled, got a check-in, answered the word, and never went on).
//   * mid-conversation (auto-forward on, Claude just talked): ONE follow-up with
//     its own [MSG #] (not a check-in), the conversation resumes, and Claude's next
//     reply is shown and passed on to ChatGPT like any other reply;
//   * Claude still owed an answer to a message (it stalled): that message is sent
//     again in the follow-up, with its [MSG #];
//   * an idle AI: no follow-up;
//   * Stop AIs Talking pressed while the check-in ran: no follow-up;
//   * the setting off: no follow-up.
// Run with: node test/checkin-continue-main.test.js
process.env.AUTOINJECTOR_POLL_MS = "50";
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = "30";
process.env.AUTOINJECTOR_CAPTURE_SETTLE_MS = "100";
process.env.AUTOINJECTOR_STABLE_MS = "80";
process.env.AUTOINJECTOR_NOTAG_QUIET_MS = "400";
process.env.AUTOINJECTOR_SEND_BUSY_POLL_MS = "50";
process.env.AUTOINJECTOR_BRIDGE = "0";
process.env.AUTOINJECTOR_CHECKIN = "0"; // no automatic ones: every check-in here is asked for
process.env.AUTOINJECTOR_PROBE_TIMEOUT_MS = "3000";
process.env.AUTOINJECTOR_PROBE_SEND_TIMEOUT_MS = "4000";
process.env.AUTOINJECTOR_PROBE_EARLY_MS = "500";
process.env.AUTOINJECTOR_CHECKIN_OWED_DEMAND_MS = "300"; // a stalled message stops blocking a check-in after this (3 min in the app)
process.env.AUTOINJECTOR_CARRY_ON_RECENT_MS = "60000";
process.env.AUTOINJECTOR_AKOWE_DIR = require("path").join(require("os").tmpdir(), "no-akowe-here-" + process.pid);

const path = require("path");
const fs = require("fs");
const Module = require("module");
const mockElectronPath = path.join(__dirname, "mock-electron.js");
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return require(mockElectronPath);
  return originalLoad.apply(this, arguments);
};
const mockElectron = require(mockElectronPath);
mockElectron.shell = { openExternal: async () => {}, openPath: async () => "" };
mockElectron.clipboard = { writeText: () => {} };
const SR = require("../self-repair");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); }
  else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 8000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const r = await fn(); if (r) return r; await sleep(step); }
  return null;
}
const call = (ch, p) => mockElectron.__ipcHandlers[ch]({}, p);
const reg = (s) => mockElectron.__registry[s];
const CHECKIN_RE = /Reply with only this word: ([a-z]+)/;
const isCarryOn = (t) => String(t || "").includes(SR.CARRY_ON_TEXT);

async function main() {
  require(path.join(__dirname, "..", "main.js"));
  await waitUntil(() => reg("chatgpt") && reg("claude") && reg("gemini") && reg("controls-ui"));
  const userData = mockElectron.app.getPath("userData");
  const logNow = () => fs.readFileSync(path.join(userData, "autoinjector-debug.log"), "utf8");
  const continueLines = (site) => logNow().split("\n").filter((l) => /"kind":"checkin-continue"/.test(l) && l.includes(`"site":"${site}"`)).map((l) => JSON.parse(l));
  const feed = [];
  reg("controls-ui").webContents.on("ipc-send", (channel, payload) => { if (channel === "akowe-activity" && payload && payload.event) feed.push(payload.event); });
  await waitUntil(async () => (await call("selfrepair:status")).ok);
  const st0 = await call("selfrepair:status");
  assert(st0.settings.carryOn === true, "the setting “After a check-in, ask the AI to carry on” is ON by default");

  // The fake AIs: a check-in gets ONLY its word, then the AI stops. What a carry-on
  // follow-up gets is up to each scenario (onCarryOn).
  const cw = reg("claude").webContents, gw = reg("gemini").webContents, chw = reg("chatgpt").webContents;
  const seen = new Set();
  let onCarryOn = null;
  let holdCheckin = false;
  const responder = setInterval(() => {
    for (const [site, w] of [["claude", cw], ["gemini", gw]]) {
      w.sentLog.forEach((e, i) => {
        const key = `${site}:${i}:${e.ts}`;
        if (seen.has(key)) return;
        const m = CHECKIN_RE.exec(e.text || "");
        if (m) { if (holdCheckin) return; seen.add(key); w.currentText = `[TO: USER]\n${m[1]}\n[FROM: ${site.toUpperCase()}]`; return; }
        seen.add(key);
        if (isCarryOn(e.text) && onCarryOn) { const r = onCarryOn(site, e.text); if (r) setTimeout(() => { w.currentText = r; }, 60); }
      });
    }
  }, 20);
  const checkInAndSettle = async (site) => {
    const pr = await call("selfrepair:probe", { sites: [site] });
    assert(pr.ok && pr.started.join() === site, `a check-in to ${site} starts (${JSON.stringify(pr.skipped)})`);
    return waitUntil(async () => { const x = (await call("selfrepair:status")).sites[site]; return !x.running && x.lastProbeOkAt ? x : null; }, 10000);
  };

  // ---------------------------------------------------------------------------------
  console.log("\n== an idle AI: the check-in is answered, and NO follow-up is sent ==");
  gw.sentLog = [];
  let ok = await checkInAndSettle("gemini");
  assert(ok && ok.state === "ok", "Gemini answered its check-in");
  await sleep(700);
  assert(gw.sentLog.length === 1 && CHECKIN_RE.test(gw.sentLog[0].text), `only the check-in was typed into Gemini (${gw.sentLog.length} messages)`);
  assert(continueLines("gemini").length === 0, "no carry-on was even considered (Gemini was doing nothing)");

  // ---------------------------------------------------------------------------------
  console.log("\n== mid-conversation (auto-forward on): ONE follow-up, the conversation goes on ==");
  await call("routing:auto-all");
  cw.sentLog = []; chw.sentLog = [];
  await call("send:compose", { text: "Plan a picnic with ChatGPT, step by step.", targets: ["claude"] });
  await waitUntil(() => cw.sentLog.some((x) => /Plan a picnic/.test(x.text)));
  cw.currentText = "[TO: CHATGPT]\nStep 1: pick a park. Your turn — CLAUDE-STEP-1.\n[FROM: CLAUDE]";
  assert(await waitUntil(() => chw.sentLog.some((x) => /CLAUDE-STEP-1/.test(x.text))), "(Claude's reply is passed on to ChatGPT — a running conversation)");
  // ChatGPT is still thinking; Claude now gets a check-in (e.g. it looked stalled)
  onCarryOn = (site) => (site === "claude" ? "[TO: CHATGPT]\nStep 2: bring sandwiches — CLAUDE-STEP-2.\n[FROM: CLAUDE]" : null);
  const t0 = (await call("state:get")).transcript.length;
  ok = await checkInAndSettle("claude");
  assert(ok && ok.state === "ok", "Claude answered the check-in with only its word");
  const fu = await waitUntil(() => cw.sentLog.find((x) => isCarryOn(x.text)), 5000);
  assert(!!fu, "AutoInjector sent Claude a follow-up after the check-in answer");
  const probeIdx = cw.sentLog.findIndex((x) => CHECKIN_RE.test(x.text));
  assert(fu && cw.sentLog.indexOf(fu) > probeIdx, "…right after the check-in (not before it)");
  assert(fu && /^\[MSG #\d{4}\]\n/.test(fu.text) && fu.text.includes(SR.CARRY_ON_TEXT) && /start with \[TO: who it's for\] and end with \[FROM: CLAUDE\]/.test(fu.text) && !CHECKIN_RE.test(fu.text), `the follow-up has its own [MSG #], the carry-on text and the usual tags rule — and is not a check-in [${fu && fu.text.slice(0, 160).replace(/\n/g, " | ")}]`);
  assert(fu && !/You had not answered/.test(fu.text), "nothing was owed, so nothing is sent again");
  const fwd = await waitUntil(() => chw.sentLog.find((x) => /CLAUDE-STEP-2/.test(x.text)), 6000);
  assert(!!fwd, "the conversation resumed: Claude's next reply was passed on to ChatGPT (auto-forward goes on)");
  const tr = (await call("state:get")).transcript;
  assert(tr.length > t0 && tr.some((t) => t.site === "claude" && /CLAUDE-STEP-2/.test(t.text)) && !tr.some((t) => t.site === "claude" && CHECKIN_RE.test(t.text)), "…and is shown in the conversation like any reply (the check-in answer is not)");
  await sleep(900);
  assert(cw.sentLog.filter((x) => isCarryOn(x.text)).length === 1, `the follow-up was sent exactly once (${cw.sentLog.filter((x) => isCarryOn(x.text)).length})`);
  let lines = continueLines("claude");
  assert(lines.length === 1 && lines[0].detail.sent === true && lines[0].detail.resent === "none" && /auto-forward|recent/.test(lines[0].detail.reason), `logged: checkin-continue (site claude, reason ${lines[0] && lines[0].detail.reason}, resent none)`);
  assert(feed.some((e) => e.kind === "repair" && e.site === "claude" && /Asked Claude to carry on where it left off/.test(e.say)), "the activity feed says “Asked Claude to carry on where it left off”");
  assert(!logNow().includes(SR.CARRY_ON_TEXT) && !logNow().includes("CLAUDE-STEP-2"), "the log carries no message text");

  // ---------------------------------------------------------------------------------
  console.log("\n== Claude still owed an answer (it stalled): that message is sent again ==");
  await call("routing:pause-all");
  cw.sentLog = [];
  onCarryOn = (site, text) => (site === "claude" && /OWED-QUESTION-7/.test(text) ? "[TO: USER]\nThe answer to question 7 is 42 — ANSWER-7.\n[FROM: CLAUDE]" : null);
  await call("send:compose", { text: "What is six times seven? OWED-QUESTION-7", targets: ["claude"] });
  const owedMsg = await waitUntil(() => cw.sentLog.find((x) => /OWED-QUESTION-7/.test(x.text)));
  const owedSeq = owedMsg && /^\[MSG #(\d{4})\]/.exec(owedMsg.text)[1];
  // Claude never answers it (stalled); a while later a check-in is allowed
  await sleep(500);
  ok = await checkInAndSettle("claude");
  assert(ok && ok.state === "ok", "Claude answered the check-in (only the word)");
  const fu2 = await waitUntil(() => cw.sentLog.find((x) => isCarryOn(x.text)), 5000);
  assert(fu2 && fu2.text.includes(`You had not answered [MSG #${owedSeq}] yet`) && /OWED-QUESTION-7/.test(fu2.text), `the follow-up sends the owed message again, with its [MSG #${owedSeq}]`);
  const ans7 = await waitUntil(async () => (await call("state:get")).transcript.find((t) => t.site === "claude" && /ANSWER-7/.test(t.text)), 6000);
  assert(!!ans7, "Claude's real answer is captured as a normal reply");
  lines = continueLines("claude");
  assert(lines.length === 2 && Array.isArray(lines[1].detail.resent) && lines[1].detail.resent.join() === owedSeq && /owed/.test(lines[1].detail.reason), `logged with the re-sent [MSG #] (${lines[1] && JSON.stringify(lines[1].detail.resent)})`);

  // ---------------------------------------------------------------------------------
  console.log("\n== Stop AIs Talking pressed while the check-in ran: no follow-up ==");
  await call("routing:auto-all");
  await call("send:compose", { text: "Keep planning. STOP-CASE", targets: ["claude"] });
  await waitUntil(() => cw.sentLog.some((x) => /STOP-CASE/.test(x.text)));
  cw.currentText = "[TO: CHATGPT]\nStep 3: blankets — STOP-CASE-REPLY.\n[FROM: CLAUDE]";
  await waitUntil(async () => (await call("state:get")).transcript.some((t) => /STOP-CASE-REPLY/.test(t.text)));
  cw.sentLog = [];
  holdCheckin = true;
  const pr = await call("selfrepair:probe", { sites: ["claude"] });
  assert(pr.started.join() === "claude", "a check-in to Claude starts");
  await waitUntil(() => cw.sentLog.some((x) => CHECKIN_RE.test(x.text)));
  await call("relay:silence"); // the user presses Stop AIs Talking
  holdCheckin = false;
  ok = await waitUntil(async () => { const x = (await call("selfrepair:status")).sites.claude; return !x.running ? x : null; }, 10000);
  await sleep(800);
  assert(ok && ok.state === "ok" && !cw.sentLog.some((x) => isCarryOn(x.text)), "the check-in was answered, and NO follow-up went out after Stop");
  lines = continueLines("claude");
  assert(lines.length === 3 && lines[2].detail.sent === false && lines[2].detail.skipped === "stopped", `logged as not sent: stopped (${lines[2] && lines[2].detail.skipped})`);

  // ---------------------------------------------------------------------------------
  console.log("\n== the setting off: no follow-up ==");
  await call("routing:auto-all"); // talking again
  const s2 = await call("selfrepair:settings", { carryOn: false });
  assert(s2.ok && s2.settings.carryOn === false, "“After a check-in, ask the AI to carry on” switched off");
  await sleep(100);
  assert(JSON.parse(fs.readFileSync(path.join(userData, "autoinjector-state.json"), "utf8")).selfRepair.carryOn === false, "…and saved");
  await call("send:compose", { text: "One more step. OFF-CASE", targets: ["claude"] });
  await waitUntil(() => cw.sentLog.some((x) => /OFF-CASE/.test(x.text)));
  cw.currentText = "[TO: CHATGPT]\nStep 4: games — OFF-CASE-REPLY.\n[FROM: CLAUDE]";
  await waitUntil(async () => (await call("state:get")).transcript.some((t) => /OFF-CASE-REPLY/.test(t.text)));
  cw.sentLog = [];
  ok = await checkInAndSettle("claude");
  await sleep(800);
  assert(ok && !cw.sentLog.some((x) => isCarryOn(x.text)), "with the setting off, no follow-up after the check-in");
  const d = await call("akowe:diagnostics", {});
  assert(d.ok && /carry on after no/.test(d.text), "diagnostics show the setting");
  await call("selfrepair:settings", { carryOn: true });

  clearInterval(responder);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
setTimeout(() => { console.error("checkin-continue-main: still running after 3 minutes — exiting"); process.exit(1); }, 3 * 60000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
