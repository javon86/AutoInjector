// test/ai-downloads.test.js — ai-downloads.js on its own (no Electron): a file an AI gives you to download.
//   * the save path is set SYNCHRONOUSLY inside will-download, into that AI's folder, never over an existing file
//   * one listener per session, however often the pane is re-made
//   * names: no name / a blob id -> "download" + the extension of its type; Windows-unsafe names made safe
//   * progress is sent (throttled), state changes always; finished -> folder + size; logs carry the NAME only
//   * an interrupted download Chromium can resume is resumed (a few tries), then a plain-words failure
//   * busyWhy() / waitIdle() for the quit question and the app's own reloads
// Run with: node test/ai-downloads.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const AD = require("../ai-downloads");

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ai-dl-unit-"));

class FakeItem extends EventEmitter {
  constructor(o = {}) {
    super();
    this.name = o.name === undefined ? "report.zip" : o.name; this.mime = o.mime || "application/zip";
    this.total = o.total || 0; this.received = 0; this.savePath = null; this.resumes = 0; this.resumable = o.resumable !== false; this.paused = false;
  }
  getFilename() { return this.name; }
  getMimeType() { return this.mime; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  setSavePath(p) { this.savePath = p; }
  canResume() { return this.resumable; }
  resume() { this.resumes++; this.paused = false; }
  isPaused() { return this.paused; }
  progress(n) { this.received = n; this.emit("updated", {}, "progressing"); }
  finish(state = "completed") { if (state === "completed" && this.savePath) fs.writeFileSync(this.savePath, Buffer.alloc(this.received || 10, 1)); this.emit("done", {}, state); }
}

async function main() {
  const logs = []; const sent = []; const popups = [];
  const dirs = { claude: path.join(TMP, "ai-work", "claude"), chatgpt: path.join(TMP, "ai-work", "chatgpt") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const dl = AD.createAiDownloads({
    dirFor: (s) => dirs[s], label: (s) => ({ claude: "Claude", chatgpt: "ChatGPT" })[s] || s,
    log: (k, d) => logs.push({ k, d }), emit: (p) => sent.push(p), progressMs: 0, resumeDelayMs: 5, maxResumes: 2,
    isPane: (_s, wc) => wc === "pane", onPopup: (wc, phase) => popups.push([wc, phase])
  });

  console.log("\n== names ==");
  assert(AD.cleanName("report.zip") === "report.zip", "a normal name stays");
  assert(AD.cleanName("", "application/zip") === "download.zip", "no name -> download.zip (from the type)");
  assert(AD.cleanName("3f2a9c1e-1b2c-4d5e-8f90-123456789abc", "application/pdf") === "download.pdf", "a blob id -> download.pdf");
  assert(AD.cleanName('my: "chapter"?*.docx') === "my chapter.docx", `Windows-unsafe characters go (${AD.cleanName('my: "chapter"?*.docx')})`);
  assert(AD.cleanName("CON.txt") === "CON_.txt" && AD.cleanName("notes. ") === "notes", "reserved Windows names / trailing dots are fixed");
  const long = AD.cleanName("x".repeat(300) + ".zip");
  assert(long.length <= 120 && long.endsWith(".zip"), "a very long name is shortened but keeps .zip");
  assert(AD.cleanName("..\\..\\evil.zip") === "evil.zip" || !/[\\/]/.test(AD.cleanName("..\\..\\evil.zip")), "no path parts");
  assert(AD.canOpen("report.zip") && AD.canOpen("a.PDF") && !AD.canOpen("setup.exe") && !AD.canOpen("run.bat") && !AD.canOpen("x"), "Open file only for documents / media / archives, never programs");

  console.log("\n== once per session ==");
  const ses = new EventEmitter();
  assert(dl.attach(ses, "claude") === true && dl.attach(ses, "claude") === false, "attach() a second time on the same session does nothing");
  assert(ses.listenerCount("will-download") === 1, "one will-download listener");

  console.log("\n== the save path is set synchronously, in Claude's folder ==");
  const it = new FakeItem({ total: 7 * 1024 * 1024 });
  ses.emit("will-download", {}, it, "pane");
  assert(it.savePath === path.join(dirs.claude, "report.zip"), `setSavePath right away (${it.savePath})`);
  assert(sent.length === 1 && sent[0].state === "progressing" && sent[0].label === "Claude" && sent[0].folder === dirs.claude, "the panel is told at once");
  const it2 = new FakeItem({ total: 100 });
  ses.emit("will-download", {}, it2, "pane");
  assert(it2.savePath === path.join(dirs.claude, "report-1.zip"), `a second report.zip at the same time gets report-1.zip (${it2.savePath && path.basename(it2.savePath)})`);
  assert(dl.active("claude").length === 2 && dl.active("chatgpt").length === 0, "two coming in for Claude");
  assert(/a download is still coming in \(Claude: report\.zip, Claude: report-1\.zip\)/.test(dl.busyWhy()[0] || ""), `busyWhy in plain words (${dl.busyWhy()[0]})`);

  console.log("\n== progress ==");
  it.progress(3 * 1024 * 1024);
  const pr = sent[sent.length - 1];
  assert(pr.percent === 42 && /⬇ Claude: report\.zip — 42% · 3 MB of 7 MB/.test(pr.text), `progress line (${pr.text})`);

  console.log("\n== interrupted -> resumed; done ==");
  it.emit("updated", {}, "interrupted");
  assert(sent[sent.length - 1].state === "resuming" && /broke off; trying again \(1 of 2\)/.test(sent[sent.length - 1].text), "the panel says it is trying again");
  await sleep(20);
  assert(it.resumes === 1, "item.resume() was called");
  it.progress(7 * 1024 * 1024);
  assert(sent[sent.length - 1].state === "progressing", "progressing again");
  const w = dl.waitIdle("claude", 2000);
  it.finish("completed");
  const fin = sent[sent.length - 1];
  assert(fin.state === "completed" && fin.file === path.join(dirs.claude, "report.zip") && fin.canOpen === true && /Claude gave you report\.zip \(7 MB\)/.test(fin.text), `completed notice (${fin.text})`);
  const okLog = logs.find((l) => l.k === "ai-download" && l.d.state === "completed");
  assert(okLog && okLog.d.name === "report.zip" && okLog.d.bytes === 7 * 1024 * 1024 && !JSON.stringify(okLog.d).includes(TMP), "the log has the state, size and NAME — not the full path");
  assert(logs.every((l) => !JSON.stringify(l.d).includes(TMP)), "no log line carries the folder path");
  it2.progress(50); it2.finish("completed");
  const wr = await w;
  assert(wr.still === 0, "waitIdle() resolves once Claude's downloads are in");
  assert(dl.byId(fin.id) && dl.byId(fin.id).state === "completed", "byId finds a finished download (for 📂 Open folder / Open file)");

  console.log("\n== broken off for good -> plain words ==");
  const it3 = new FakeItem({ name: "big.zip", total: 1000 });
  ses.emit("will-download", {}, it3, "pane");
  it3.emit("done", {}, "interrupted"); await sleep(15);
  it3.emit("done", {}, "interrupted"); await sleep(15);
  assert(it3.resumes === 2, `resumed twice (the limit) (${it3.resumes})`);
  it3.emit("done", {}, "interrupted");
  const bad = sent[sent.length - 1];
  assert(bad.state === "failed" && /kept breaking off.*click the download in Claude's pane again/i.test(bad.text), `failed, in plain words (${bad.text})`);
  const it4 = new FakeItem({ name: "x.zip", resumable: false });
  ses.emit("will-download", {}, it4, "pane");
  it4.emit("done", {}, "interrupted");
  assert(sent[sent.length - 1].state === "failed" && it4.resumes === 0 && /stopped before it finished/.test(sent[sent.length - 1].text), "not resumable -> failed at once, with the reason");
  const it5 = new FakeItem({ name: "y.zip" });
  ses.emit("will-download", {}, it5, "pane");
  it5.emit("done", {}, "cancelled");
  assert(sent[sent.length - 1].state === "cancelled" && dl.active().length === 0, "cancelled -> said, and nothing is coming in any more");

  console.log("\n== a popup window the pane opened, and a nameless blob ==");
  const ses2 = new EventEmitter(); dl.attach(ses2, "chatgpt");
  const it6 = new FakeItem({ name: "", mime: "text/markdown" });
  ses2.emit("will-download", {}, it6, "popup-wc");
  assert(it6.savePath === path.join(dirs.chatgpt, "download.md"), `from a popup: same AI folder, a real name (${it6.savePath && path.basename(it6.savePath)})`);
  assert(popups.length === 1 && popups[0][0] === "popup-wc" && popups[0][1] === "start", "the popup is reported (main.js hides an empty one)");
  it6.finish("completed");
  assert(popups.length === 2 && popups[1][1] === "done", "…and closes it once the file is in");

  console.log("\n== paused by something else -> carried on ==");
  const it7 = new FakeItem({ name: "p.zip", total: 10 });
  ses2.emit("will-download", {}, it7, "pane");
  it7.paused = true; it7.emit("updated", {}, "progressing");
  assert(sent[sent.length - 1].state === "paused", "paused is shown");
  await sleep(20);
  assert(it7.resumes === 1, "and resumed");
  it7.finish("completed");

  console.log("\n== no folder -> the fallback folder, still no Save dialog ==");
  const fb = path.join(TMP, "fallback");
  const dlB = AD.createAiDownloads({ dirFor: () => { throw new Error("not initialized"); }, fallbackDir: () => fb, emit: () => {}, log: () => {} });
  const s3 = new EventEmitter(); dlB.attach(s3, "gemini");
  const it8 = new FakeItem({ name: "a.pdf" });
  s3.emit("will-download", {}, it8, null);
  assert(it8.savePath === path.join(fb, "a.pdf") && fs.existsSync(fb), "saved into the fallback folder");

  console.log("\n== waitIdle times out ==");
  const it9 = new FakeItem({ name: "slow.zip" });
  ses.emit("will-download", {}, it9, "pane");
  const t0 = Date.now();
  const r9 = await dl.waitIdle("claude", 60);
  assert(r9.still === 1 && Date.now() - t0 >= 55, "gives up after maxMs, saying one is still coming in");
  it9.finish("cancelled");

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
