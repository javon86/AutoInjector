'use strict';
// test/ease.test.js — the ease-of-use helpers without Electron:
//   ease.js        ✅ checklist rows (ok / ✖ / ⏳ + Fix it), when it opens by itself, 🩺 problems (worst first, one per
//                  thing, at most 5), the 24-hour log scan (kinds and counts only — never an event's text), settings
//   guide-render.js the user guide as one safe page (escaped, only #anchor / http(s) links, tables, lists, contents)
//   ease-main.js   the IPC channels with stub getters: a slow getter becomes ⏳, Fix it only runs listed actions and
//                  only opens folders / links a row offered, the support report never asks for the conversation,
//                  the guide window, auto-open is off under automation
// Run: node test/ease.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const ease = require('../ease');
const guide = require('../guide-render');
const { installEase, autoAllowed, MAIN_ACTIONS } = require('../ease-main');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const GB = 1024 ** 3;
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

const goodSnap = () => ({
  sites: [{ site: 'chatgpt', label: 'ChatGPT', active: true, state: 'ok' }, { site: 'claude', label: 'Claude', active: true, state: 'ok' }, { site: 'gemini', label: 'Gemini', active: true, state: 'ok' }],
  akowe: { enabled: true, phase: 'running' },
  llm: { ok: true, ollama: { installed: true }, server: { running: true }, models: ['qwen2.5:7b'] },
  voice: { installed: true, running: false },
  sd: { connected: true, label: 'Forge' },
  video: { ready: true, message: '✔ Ready: FramePack (found)' },
  claudeCode: { state: 'ready', words: '✔ Claude Code 2.1 found, signed in' },
  content: { dir: 'C:\\AI\\stuff and thing', reason: 'chosen', others: [] },
  disk: { freeBytes: 200 * GB, path: 'C:\\AI\\stuff and thing' },
});

async function main() {
  console.log('\n== ✅ checklist: everything ready ==');
  let cl = ease.buildChecklist(goodSnap());
  const ids = cl.items.map((i) => i.id);
  assert(['pane-chatgpt', 'pane-claude', 'pane-gemini', 'akowe', 'content', 'disk', 'alfred-ai', 'voice', 'sd', 'video', 'claude-code'].every((id) => ids.includes(id)) && cl.items.length === 11, `11 rows: ${ids.join(', ')}`);
  assert(cl.items.every((i) => i.ok === true), 'all ✔');
  assert(cl.neededOk && cl.neededBad === 0 && /Everything needed for books is ready/.test(cl.summary), `summary: ${cl.summary}`);
  assert(cl.items.filter((i) => i.group === 'needed').map((i) => i.id).join() === 'pane-chatgpt,pane-claude,pane-gemini,akowe,content,disk', 'needed for books: the 3 sign-ins, Akọwe, the content folder, disk space');
  assert(cl.items.filter((i) => i.group === 'optional').length === 5, 'optional extras: Alfred\'s AI, voice, Stable Diffusion, video, Claude Code');
  assert(!ease.shouldAutoOpen({ auto: true, prefs: {}, checklist: cl }), 'all needed ✔ → it does not open by itself, not even the first time');

  console.log('\n== ✅ checklist: problems, each with its Fix it ==');
  const s = goodSnap();
  s.sites[0] = { site: 'chatgpt', label: 'ChatGPT', active: true, state: 'needs_user', problem: 'LOGGED_OUT' };
  s.sites[1] = { site: 'claude', label: 'Claude', active: false, state: 'ok' };
  s.sites[2] = { site: 'gemini', label: 'Gemini', active: true, state: 'unknown' };
  s.akowe = { enabled: true, phase: 'failed', error: 'NO_PYTHON', message: 'Akọwe needs Python 3.10 or newer.', pythonDownloadUrl: 'https://www.python.org/downloads/' };
  s.llm = { ok: true, ollama: { installed: true }, server: { running: false }, models: [] };
  s.voice = { installed: false, reason: 'needs Python, which was not found' };
  s.sd = { connected: false, found: ['Forge (Stability Matrix)'] };
  s.video = { ready: false, message: 'Video is not set up yet.' };
  s.claudeCode = { state: 'signed_out', words: 'Signed out: open a terminal (PowerShell), run `claude` once and sign in' };
  s.content = { dir: 'C:\\AI\\stuff and thing', reason: 'default', others: [{ root: 'D:\\Old', dir: 'D:\\Old\\stuff and thing', what: ['models'], bytes: 9 * GB }] };
  s.disk = { freeBytes: 3 * GB, path: 'C:\\AI\\stuff and thing' };
  cl = ease.buildChecklist(s);
  const by = Object.fromEntries(cl.items.map((i) => [i.id, i]));
  assert(by['pane-chatgpt'].ok === false && /not signed in/.test(by['pane-chatgpt'].text) && by['pane-chatgpt'].fix.action === 'pane-open' && by['pane-chatgpt'].fix.args.site === 'chatgpt', 'logged out → ✖ "not signed in" + Open ChatGPT to sign in');
  assert(by['pane-claude'].ok === false && by['pane-claude'].fix.action === 'pane-on', 'Active unticked → ✖ + Turn Claude on');
  assert(by['pane-gemini'].ok === null && by['pane-gemini'].fix.action === 'pane-check', 'not checked yet → ⏳ + Check now');
  assert(by.akowe.ok === false && by.akowe.fix.action === 'open-url' && /python\.org/.test(by.akowe.fix.args.url), 'Akọwe without Python → Get Python');
  assert(by['alfred-ai'].ok === false && by['alfred-ai'].fix.action === 'llm-start', 'Ollama installed, not running → ▶ Start Ollama');
  assert(by.voice.ok === false && by.voice.fix.action === 'wizard' && by.voice.fix.args.tab === 'advanced', 'no voice engine → the Setup Wizard\'s Installs tab');
  assert(by.sd.ok === true && /Found Forge/.test(by.sd.text), 'Stable Diffusion found but not started → ✔ (it can be started)');
  assert(by.video.ok === false && by.video.fix.args.tab === 'video', 'video not set up → Open 🎬 Video');
  assert(by['claude-code'].ok === null && /once it is running/.test(by['claude-code'].text), 'Claude Code waits while Akọwe is not running (⏳)');
  const cc = ease.buildChecklist(Object.assign(goodSnap(), { claudeCode: s.claudeCode })).items.find((i) => i.id === 'claude-code');
  assert(cc.ok === false && cc.fix.action === 'claude-code' && /Signed out/.test(cc.text), 'Claude Code signed out → ✖ (Akọwe\'s own words) + open Akọwe ⚙️ Settings');
  assert(by.content.ok === false && by.content.fix.action === 'content-use' && by.content.fix.args.root === 'D:\\Old', 'earlier downloads elsewhere → 📁 Use that folder');
  assert(by.disk.ok === false && /Only 3\.0 GB free/.test(by.disk.text) && by.disk.fix.action === 'open-folder', 'under 5 GB → ✖ + Open the folder');
  assert(!cl.neededOk && cl.neededBad === 5, `5 needed things to fix (${cl.summary})`);
  assert(ease.shouldAutoOpen({ auto: true, prefs: {}, checklist: cl }) && ease.shouldAutoOpen({ auto: true, prefs: { checklistShownAt: 1 }, checklist: cl }), 'opens by itself on the first start and while something needed is ✖');
  assert(!ease.shouldAutoOpen({ auto: true, prefs: { dontShowChecklist: true }, checklist: cl }) && !ease.shouldAutoOpen({ auto: false, prefs: {}, checklist: cl }), '"don\'t show again" and automation keep it closed');
  const unsure = ease.buildChecklist(Object.assign(goodSnap(), { sites: goodSnap().sites.map((x) => Object.assign({}, x, { state: 'unknown' })) }));
  assert(!ease.shouldAutoOpen({ auto: true, prefs: { checklistShownAt: 1 }, checklist: unsure }), 'later starts: ⏳ "not checked yet" alone does not open it again');
  const akOff = ease.buildChecklist(Object.assign(goodSnap(), { akowe: { enabled: false, phase: 'idle' }, claudeCode: null }));
  assert(akOff.items.find((i) => i.id === 'akowe').fix.action === 'akowe-on' && akOff.items.find((i) => i.id === 'claude-code').ok === null, 'Akọwe switched off → Turn it on; Claude Code waits for Akọwe (⏳)');
  const limited = ease.buildChecklist(Object.assign(goodSnap(), { sites: [{ site: 'claude', label: 'Claude', active: true, state: 'needs_user', problem: 'USAGE_LIMIT' }] }));
  assert(limited.items[0].ok === true && /usage limit/.test(limited.items[0].text), 'at the usage limit is still signed in (✔, with a note)');
  const broken = ease.buildChecklist({ sites: null, akowe: null, llm: null, voice: null, sd: null, video: null, claudeCode: null, content: null, disk: { freeBytes: NaN } });
  assert(broken.items.length === 8 && broken.items.every((i) => i.ok === null || i.ok === false) && !broken.neededOk, 'nothing known → ⏳ rows, never a crash');
  const big = ease.buildChecklist(Object.assign(goodSnap(), { disk: { freeBytes: 10 * GB, path: '/x' } }));
  assert(big.items.find((i) => i.id === 'disk').ok === true && /10 GB free\. One AI model/.test(big.items.find((i) => i.id === 'disk').text), 'under 15 GB: ✔ with a warning');

  console.log('\n== 🩺 the 24-hour log scan: kinds and counts only ==');
  const SECRET = 'my private chapter about Mara';
  const log = [
    ...Array.from({ length: 4 }, (_, i) => ({ ts: NOW - 3600e3 + i, kind: 'sd-runner-error', level: 'error', detail: { error: SECRET } })),
    { ts: NOW - 120e3, kind: 'video-ipc-error', level: 'error', detail: { error: SECRET } },
    { ts: NOW - 30 * 3600e3, kind: 'sd-runner-error', level: 'error' }, // older than 24 h
    { ts: NOW - 60e3, kind: 'sd-start', level: 'info' },
    { ts: NOW - 60e3, kind: 'selftest-fail', level: 'error' }, // the app's own test
    { ts: NOW - 60e3, kind: 'akowe-thing', level: 'info', detail: { severity: 'error' } },
  ];
  const groups = ease.scanLog(log, NOW);
  assert(groups[0].area.includes('Pictures') && groups[0].count === 4 && groups[0].kinds[0].kind === 'sd-runner-error', `pictures: 4 errors in the last 24 h (${JSON.stringify(groups[0].kinds)})`);
  assert(groups.some((g) => g.area.includes('Akọwe') && g.count === 1) && groups.some((g) => g.area.includes('Video')), 'a detail severity "error" counts; video too');
  assert(!JSON.stringify(groups).includes(SECRET), 'no event text in the result');

  console.log('\n== 🩺 problems: worst first, one per thing, at most 5 ==');
  const ps = ease.findProblems({
    sites: s.sites,
    akowe: s.akowe,
    health: [{ code: 'disk-low:content', check: 'disk', severity: 'urgent', text: '💾 The drive is almost full.', fix: { label: '📂 Open the folder' } }, { code: 'brain-ollama-down', check: 'brain', severity: 'warn', text: '🎩 Alfred\'s brain isn\'t answering.', fix: { label: '▶ Start Ollama' } }],
    runConditions: [{ key: 'run:b1:paused', title: 'Your book run is paused', body: '“Mara” is paused (step 4 of 9). Open Akọwe and press ▶ Resume when you are ready.', target: 'akowe' }, { key: 'pane:chatgpt:needs_user:LOGGED_OUT', title: 'ChatGPT needs you', body: 'ChatGPT is logged out.', target: 'pane', site: 'chatgpt' }],
    voice: { installed: true, lastStartError: 'boom' },
    log,
  }, { now: NOW });
  assert(ps.length === 5, `5 problems at most (${ps.length})`);
  assert(ps[0].severity === 'urgent' && /book run is paused/.test(ps[0].text) && ps[0].fix.action === 'tab' && ps[0].fix.args.tab === 'akowe', 'the paused book first, with Open 📖 Akọwe');
  assert(ps.filter((p) => p.id === 'pane-chatgpt').length === 1, 'ChatGPT once (the run guard and the pane state are not doubled)');
  assert(ps.some((p) => p.id === 'akowe' && p.fix.action === 'open-url'), 'Akọwe failed → Get Python');
  assert(ps.some((p) => p.fix && p.fix.action === 'health-fix' && p.fix.args.code === 'disk-low:content'), 'health-watch problems keep their fix (by code)');
  const urgentIdx = ps.map((p) => p.severity).lastIndexOf('urgent'), warnIdx = ps.map((p) => p.severity).indexOf('warn');
  assert(warnIdx === -1 || urgentIdx < warnIdx, 'urgent before warn');
  const logOnly = ease.findProblems({ log }, { now: NOW });
  assert(logOnly.length === 1 && /Pictures.*4 errors in the last 24 hours/.test(logOnly[0].text) && /codes: sd-runner-error/.test(logOnly[0].text) && !logOnly[0].text.includes(SECRET), `from the log alone: "${logOnly[0] && logOnly[0].text}"`);
  assert(ease.findProblems({ sites: goodSnap().sites, akowe: goodSnap().akowe, health: [], runConditions: [], log: [] }, { now: NOW }).length === 0, 'all fine → no problems');
  const allLimited = ease.findProblems({ sites: goodSnap().sites.map((x) => Object.assign({}, x, { state: 'needs_user', problem: 'USAGE_LIMIT' })) });
  assert(allLimited.length === 1 && /Every AI/.test(allLimited[0].text), 'every AI at its limit → one line, not three');

  console.log('\n== settings ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ease-test-'));
  const pf = path.join(tmp, 'p.json');
  const pr = ease.createPrefs(pf);
  assert(pr.get().dontShowChecklist === false && !pr.get().checklistShownAt && JSON.stringify(pr.get().toursSeen) === '{}', 'defaults');
  pr.set({ checklistShown: true, tourSeen: 'main' }); pr.set({ tourSeen: 'video', dontShowChecklist: true }); pr.set({ tourSeen: '../evil' });
  const pr2 = ease.createPrefs(pf).get();
  assert(pr2.dontShowChecklist && pr2.checklistShownAt > 0 && pr2.toursSeen.main && pr2.toursSeen.video && Object.keys(pr2.toursSeen).length === 2, 'saved and read back (bad tour names ignored)');
  assert(JSON.stringify(ease.createPrefs(pf).set({ resetTours: true }).toursSeen) === '{}', 'Replay tours clears the seen list');
  fs.writeFileSync(pf, '{not json');
  assert(ease.createPrefs(pf).get().dontShowChecklist === false, 'an unreadable file → the defaults');

  console.log('\n== guide-render: one safe page ==');
  const md = '# Guide\n\n## 1. Start\n\nDouble-click **run-windows.bat** and `wait`.\n\n- one\n  - nested\n- two <script>alert(1)</script>\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| x | [y](https://example.com) |\n\n> a note\n\nSee [section](#1-start), [a file](../README.md) and [bad](javascript:alert(1)).\n\n```\ncode <b>\n```\n\n## 1. Start\n';
  const r = guide.render(md);
  assert(/<h1 id="guide">Guide<\/h1>/.test(r.html) && r.toc.length === 2 && r.toc[0].id === '1-start' && r.toc[1].id !== r.toc[0].id, `headings with unique anchors (${r.toc.map((t) => t.id)})`);
  assert(/<strong>run-windows\.bat<\/strong>/.test(r.html) && /<code>wait<\/code>/.test(r.html), 'bold and code');
  assert(/<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two &lt;script&gt;/.test(r.html), 'nested lists; HTML escaped');
  assert(/<ol><li>first<\/li><li>second<\/li><\/ol>/.test(r.html), 'numbered list');
  assert(/<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>x<\/td><td><a href="https:\/\/example\.com" class="ext">y<\/a><\/td>/.test(r.html), 'a table with an outside link');
  assert(/<a href="#1-start">section<\/a>/.test(r.html) && !/README\.md/.test(r.html.replace(/a file/, '')) && !/javascript:/.test(r.html), 'only #anchors and http(s) links; file and javascript: links become words');
  assert(/<blockquote><p>a note<\/p><\/blockquote>/.test(r.html) && /<pre><code>code &lt;b&gt;<\/code><\/pre>/.test(r.html), 'notes and code blocks');
  const pg = guide.page(md);
  assert(/Content-Security-Policy" content="default-src 'none'/.test(pg) && !/<script/i.test(pg) && /<nav aria-label="Contents">/.test(pg), 'the page: strict CSP, no scripts, a contents list');
  const real = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8');
  const rr = guide.render(real);
  assert(rr.toc.length >= 12 && ['Starting the app', 'Making a book', 'Story map', 'checked', 'Pictures', 'Video', 'Voice', 'downloads', 'Alfred', 'Claude Code', 'wrong', 'Updating'].every((w) => rr.toc.some((t) => t.text.includes(w))), `docs/USER_GUIDE.md renders with every topic (${rr.toc.length} sections)`);

  console.log('\n== ease-main: the IPC channels ==');
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const calls = [];
  const logs = [];
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ease-main-'));
  const snap = goodSnap();
  snap.disk = { freeBytes: 2 * GB, path: '/stuff' };
  let reportLines = null;
  const api = installEase({
    ipcMain, userDataDir: () => ud, logEvent: (k, d) => logs.push([k, d]), auto: true,
    parts: Object.assign({}, Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, () => v])), {
      llm: () => new Promise(() => {}), // never answers → ⏳ after its time limit
      health: async () => [], runConditions: () => [], log: () => [{ ts: Date.now() - 1000, kind: 'voice-start-error', level: 'error', detail: { error: 'secret words' } }, { ts: Date.now() - 900, kind: 'voice-start-error', level: 'error' }, { ts: Date.now() - 800, kind: 'voice-start-error', level: 'error' }],
    }),
    actions: { openPath: async (p) => { calls.push(['openPath', p]); return { ok: true }; }, akoweStart: async () => { calls.push(['akoweStart']); return { ok: true }; }, openExternal: async (u) => { calls.push(['openExternal', u]); return { ok: true }; } },
    buildReport: async (lines) => { reportLines = lines; return { ok: true, file: '/logs/support-report.txt', events: 3, redactions: 1 }; },
  });
  assert(['ease:prefs', 'ease:set-prefs', 'ease:checklist', 'ease:problems', 'ease:report', 'ease:report-show', 'ease:fix', 'ease:guide'].every((c) => typeof handlers[c] === 'function'), 'all 8 channels registered');
  const t0 = Date.now();
  const got = await handlers['ease:checklist']({}, {});
  assert(got.ok && got.items.length === 11 && Date.now() - t0 < 9000, `answers within the time limits (${Date.now() - t0} ms)`);
  assert(got.items.find((i) => i.id === 'alfred-ai').ok === null, 'a getter that never answers → ⏳, not a hang');
  assert(got.autoOpen === true, 'first start with a needed ✖ (disk) → opens by itself');
  assert(logs.some(([k, d]) => k === 'ease' && d.step === 'checklist' && typeof d.bad === 'number'), 'logged with counts only');
  const fixBad = await handlers['ease:fix']({}, { action: 'rm -rf', args: {} });
  assert(!fixBad.ok && fixBad.error === 'UNKNOWN_ACTION', 'an unknown fix is refused');
  const notOffered = await handlers['ease:fix']({}, { action: 'open-folder', args: { path: 'C:\\Users\\me\\Legal' } });
  assert(!notOffered.ok && notOffered.error === 'BAD_PATH' && !calls.some((c) => c[0] === 'openPath'), 'open-folder only opens a folder a row offered (never any other folder)');
  const offered = await handlers['ease:fix']({}, { action: 'open-folder', args: { path: '/stuff' } });
  assert(offered.ok && calls.some((c) => c[0] === 'openPath' && c[1] === '/stuff'), 'the offered folder opens');
  const badUrl = await handlers['ease:fix']({}, { action: 'open-url', args: { url: 'https://evil.example' } });
  assert(!badUrl.ok && !calls.some((c) => c[0] === 'openExternal'), 'open-url only opens a link a row offered');
  assert((await handlers['ease:fix']({}, { action: 'akowe-start' })).ok && calls.some((c) => c[0] === 'akoweStart'), 'akowe-start runs the existing control');
  assert(!(await handlers['ease:fix']({}, { action: 'llm-start' })).ok, 'a fix with no control in this build says so');
  assert([...MAIN_ACTIONS].every((a) => typeof a === 'string') && !MAIN_ACTIONS.has('tab'), 'tab / wizard / pane-open are done by the panel, not main');
  const probs = await handlers['ease:problems']({}, {});
  assert(probs.ok && probs.problems.length === 1 && /voice engine: 3 errors/.test(probs.problems[0].text) && !JSON.stringify(probs).includes('secret words'), `problems from the log, codes only: "${probs.problems[0] && probs.problems[0].text}"`);
  const rep = await handlers['ease:report']({}, {});
  assert(rep.ok && rep.file === '/logs/support-report.txt', 'the report is saved');
  assert(reportLines && reportLines.some((l) => /SOMETHING'S WRONG/.test(l)) && reportLines.some((l) => /✖ Enough free disk space/.test(l)) && !reportLines.join('\n').includes('secret words'), 'the report adds what was found and the checklist, never event text');
  let p = await handlers['ease:set-prefs']({}, { tourSeen: 'images', checklistShown: true });
  assert(p.ok && p.toursSeen.images && p.auto === true, 'set-prefs saves a seen tour');
  p = await handlers['ease:prefs']({}, {});
  assert(p.toursSeen.images && p.checklistShownAt > 0 && fs.existsSync(path.join(ud, 'autoinjector-ease.json')), 'prefs persisted in autoinjector-ease.json');
  const items = api.helpMenuItems(() => {});
  assert(items.map((i) => i.label).join(' | ') === "✅ Setup checklist | 🩺 Something's wrong? | 📖 User guide | 🧭 Replay tours", 'the Help menu items');

  console.log('\n== ease-main: the guide window ==');
  const made = [];
  class FakeWC { constructor() { this.handlers = {}; } loadURL(u) { this.url = u; } on(e, f) { this.handlers[e] = f; } setWindowOpenHandler(f) { this.open = f; } isDestroyed() { return false; } close() {} }
  class BaseWindow { constructor(o) { this.o = o; this.contentView = { addChildView: (v) => { this.view = v; } }; made.push(this); this.ev = {}; } getContentSize() { return [1000, 700]; } on(e, f) { this.ev[e] = f; } focus() { this.focused = true; } isDestroyed() { return false; } }
  class WebContentsView { constructor(o) { this.o = o; this.webContents = new FakeWC(); } setBounds(b) { this.b = b; } }
  const opened = [];
  const gfile = path.join(ud, 'G.md'); fs.writeFileSync(gfile, '# User guide\n\n## 1. Starting the app\n\nHello.\n');
  const g = installEase({ userDataDir: () => ud, BaseWindow, WebContentsView, shell: { openExternal: (u) => { opened.push(u); return Promise.resolve(); } }, guideFiles: [path.join(ud, 'missing.md'), gfile] });
  const go = g.openGuide();
  assert(go.ok && go.found && made.length === 1 && made[0].o.title === 'AutoInjector — User guide', 'opens a window titled "AutoInjector — User guide"');
  const html = Buffer.from(made[0].view.webContents.url.replace(/^data:text\/html;charset=utf-8;base64,/, ''), 'base64').toString('utf8');
  assert(/<h2 id="1-starting-the-app">1\. Starting the app<\/h2>/.test(html) && made[0].view.o.webPreferences.javascript === false && made[0].view.o.webPreferences.sandbox === true, 'the guide is rendered; no scripts, sandboxed');
  made[0].view.webContents.open({ url: 'https://code.claude.com/docs/en/setup' });
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  made[0].view.webContents.handlers['will-navigate'](ev, 'https://example.com/x');
  await new Promise((r) => setTimeout(r, 5));
  assert(opened.length === 2 && ev.prevented, 'outside links open in the browser, never inside the guide window');
  assert(g.openGuide().already && made.length === 1, 'a second press focuses the same window');
  const g2 = installEase({ userDataDir: () => ud, BaseWindow, WebContentsView, guideFiles: [path.join(ud, 'missing.md')] });
  const r2 = g2.openGuide();
  const html2 = Buffer.from(made[1].view.webContents.url.split(',')[1], 'base64').toString('utf8');
  assert(r2.ok && !r2.found && /github\.com\/javon86\/AutoInjector\/blob\/main\/docs\/USER_GUIDE\.md/.test(html2), 'no guide file → a page with the link to read it online');

  console.log('\n== auto-open is off under automation ==');
  assert(autoAllowed({}, ['electron', '.']) === true, 'a normal start: auto on');
  assert(autoAllowed({}, ['electron', '--inspect=0', '--remote-debugging-port=0', '.']) === false, 'Playwright (remote debugging) → off');
  assert(autoAllowed({}, ['electron', '.'], (sw) => sw === 'remote-debugging-port') === false, '…also when Electron keeps the switch out of argv (app.commandLine)');
  assert(autoAllowed({ AUTOINJECTOR_EASE_AUTO: '1' }, ['--remote-debugging-port=0']) === true && autoAllowed({ AUTOINJECTOR_EASE_AUTO: '0' }, []) === false, 'AUTOINJECTOR_EASE_AUTO=1 / 0 wins');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
