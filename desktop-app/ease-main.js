'use strict';
/*
 * ease-main.js — the main-process side of the ease-of-use helpers (✅ Setup checklist, 🩺 Something's wrong?,
 * 📖 User guide, guided tours' "seen" list). main.js hands in small read-only getters for what the app already
 * knows (pane states, Akọwe, Ollama, voice, pictures, video, Claude Code, the content folder, free space, the
 * health watch, the run guard, the activity log) and a few existing actions; this file asks them all at once
 * (each with its own time limit), turns the answers into rows with ease.js, and registers the IPC channels:
 *
 *   ease:prefs        -> { dontShowChecklist, checklistShownAt, toursSeen, auto }
 *   ease:set-prefs    { dontShowChecklist?, checklistShown?, tourSeen?, resetTours? }
 *   ease:checklist    -> { ok, items, neededOk, neededBad, summary, autoOpen }
 *   ease:problems     -> { ok, problems, checkedAt }
 *   ease:report       -> { ok, file }   a privacy-safe file for support (the last 24 hours; see buildReport)
 *   ease:fix          { action, args } -> { ok, message }   only the actions listed in MAIN_ACTIONS
 *   ease:guide        -> { ok }   opens docs/USER_GUIDE.md rendered in an app window
 *
 * "auto" (the checklist and tours opening by themselves) is off under automation (Playwright starts Electron with
 * --remote-debugging-port) unless AUTOINJECTOR_EASE_AUTO=1; AUTOINJECTOR_EASE_AUTO=0 turns it off everywhere.
 */
const fs = require('fs');
const path = require('path');
const ease = require('./ease');
const guideRender = require('./guide-render');

const PART_MS = 6000;
const MAIN_ACTIONS = new Set(['akowe-start', 'akowe-on', 'llm-start', 'claude-code', 'open-url', 'health-fix', 'content-use', 'open-folder', 'pane-check', 'pane-on']);
const GUIDE_URL = 'https://github.com/javon86/AutoInjector/blob/main/docs/USER_GUIDE.md';

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, ms);
    Promise.resolve().then(() => p()).then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } }, () => { if (!done) { done = true; clearTimeout(t); resolve(undefined); } });
  });
}

function autoAllowed(env = process.env, argv = process.argv, hasSwitch = null) {
  if (env.AUTOINJECTOR_EASE_AUTO === '1') return true;
  if (env.AUTOINJECTOR_EASE_AUTO === '0') return false;
  // Electron keeps Chromium's switches out of process.argv: ask app.commandLine too
  try { if (typeof hasSwitch === 'function' && (hasSwitch('remote-debugging-port') || hasSwitch('remote-debugging-pipe'))) return false; } catch (_) {}
  return !argv.some((a) => /^--remote-debugging-(port|pipe)/.test(String(a)));
}

function installEase(deps = {}) {
  const log = (step, detail) => { try { if (deps.logEvent) deps.logEvent('ease', Object.assign({ step }, detail || {})); } catch (_) {} };
  const parts = deps.parts || {};
  const prefs = ease.createPrefs(path.join(deps.userDataDir ? deps.userDataDir() : '.', 'autoinjector-ease.json'));
  const auto = deps.auto != null ? !!deps.auto : autoAllowed(process.env, process.argv, deps.hasSwitch);
  let lastPaths = new Set(); // folders a ✅ row offered to open (open-folder only opens these)
  let lastUrls = new Set();

  const part = (name, ms) => (typeof parts[name] === 'function' ? withTimeout(parts[name], ms || PART_MS) : Promise.resolve(undefined));

  async function snapshot(which) {
    const want = new Set(which);
    const names = ['sites', 'akowe', 'llm', 'voice', 'sd', 'video', 'claudeCode', 'content', 'disk', 'health', 'runConditions', 'log'].filter((n) => want.has(n));
    const vals = await Promise.all(names.map((n) => part(n, n === 'health' ? 12000 : PART_MS)));
    const snap = {};
    names.forEach((n, i) => { snap[n] = vals[i] == null ? null : vals[i]; });
    return snap;
  }

  async function checklist() {
    const snap = await snapshot(['sites', 'akowe', 'llm', 'voice', 'sd', 'video', 'claudeCode', 'content', 'disk']);
    const r = ease.buildChecklist(snap);
    lastPaths = new Set(r.items.map((i) => i.fix && i.fix.action === 'open-folder' && i.fix.args.path).filter(Boolean));
    lastUrls = new Set(r.items.map((i) => i.fix && i.fix.action === 'open-url' && i.fix.args.url).filter(Boolean));
    const p = prefs.get();
    const autoOpen = ease.shouldAutoOpen({ auto, prefs: p, checklist: r });
    log('checklist', { ok: r.items.filter((i) => i.ok === true).length, bad: r.items.filter((i) => i.ok === false).length, unsure: r.items.filter((i) => i.ok == null).length, neededOk: r.neededOk });
    return Object.assign({ ok: true, autoOpen }, r);
  }

  async function problems() {
    const snap = await snapshot(['sites', 'akowe', 'voice', 'health', 'runConditions', 'log']);
    const list = ease.findProblems(snap);
    for (const p of list) {
      if (p.fix && p.fix.action === 'open-url') lastUrls.add(p.fix.args.url);
    }
    log('problems', { count: list.length, ids: list.map((p) => String(p.id).slice(0, 40)) });
    return { ok: true, problems: list, checkedAt: Date.now() };
  }

  // A file for support, covering the last 24 hours: the activity log and the Relay Trace through log-extract.js
  // (its scope "time / last 24 hours" and its redaction of keys and private paths) — NEVER the AI conversation,
  // never "Everything", and no file of the user's is opened. Plus what 🩺 found and the ✅ rows, in plain words.
  let lastReport = null; // the support report this app start made — the only file 📂 Show it may show
  async function report() {
    if (typeof deps.buildReport !== 'function') return { ok: false, error: 'NOT_AVAILABLE', message: 'Reports are not available in this build.' };
    let found = []; let rows = [];
    try { found = (await problems()).problems; } catch (_) { found = []; }
    try { rows = (await checklist()).items; } catch (_) { rows = []; }
    const lines = ['', '==================== SOMETHING\'S WRONG? (what the app found) ====================', ''];
    if (!found.length) lines.push('Nothing wrong found.');
    for (const p of found) lines.push(`- [${p.severity}] ${p.text}`);
    lines.push('', '==================== SETUP CHECKLIST ====================', '');
    for (const i of rows) lines.push(`- ${i.ok === true ? '✔' : i.ok === false ? '✖' : '…'} ${i.title} — ${i.text}`);
    try {
      const r = await deps.buildReport(lines);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'REPORT_FAILED', message: 'The report could not be made.' };
      log('report', { events: r.events, redactions: r.redactions });
      lastReport = r.file;
      return { ok: true, file: r.file };
    } catch (e) { log('report-error', { error: String((e && e.code) || 'ERROR') }); return { ok: false, error: 'REPORT_FAILED', message: 'The report could not be made.' }; }
  }

  async function runFix(action, args = {}) {
    if (!MAIN_ACTIONS.has(action)) return { ok: false, error: 'UNKNOWN_ACTION', message: 'That fix is not available.' };
    const a = deps.actions || {};
    const call = async (name, ...xs) => (typeof a[name] === 'function' ? a[name](...xs) : { ok: false, error: 'NOT_AVAILABLE', message: 'That fix is not available in this build.' });
    log('fix', { action });
    try {
      if (action === 'open-url') {
        const url = String(args.url || '');
        if (!/^https:\/\//.test(url) || !lastUrls.has(url)) return { ok: false, error: 'BAD_URL', message: 'That link is not one the checklist offered.' };
        return await call('openExternal', url);
      }
      if (action === 'open-folder') {
        const p = String(args.path || '');
        if (!lastPaths.has(p)) return { ok: false, error: 'BAD_PATH', message: 'That folder is not one the checklist offered.' };
        return await call('openPath', p);
      }
      if (action === 'health-fix') return await call('healthFix', String(args.code || ''));
      if (action === 'content-use') return await call('contentUse', String(args.root || ''));
      if (action === 'pane-check' || action === 'pane-on') return await call(action === 'pane-check' ? 'paneCheck' : 'paneOn', args.site ? String(args.site) : null);
      const map = { 'akowe-start': 'akoweStart', 'akowe-on': 'akoweOn', 'llm-start': 'llmStart', 'claude-code': 'openClaudeCode' };
      return await call(map[action]);
    } catch (e) { log('fix-error', { action, error: String((e && e.code) || 'ERROR') }); return { ok: false, error: 'FIX_FAILED', message: 'That did not work. Try again, or use 🩺 Something\'s wrong?.' }; }
  }

  // ---- 📖 the user guide, in its own window
  let guideWin = null;
  let guideView = null;
  function guideText() {
    for (const f of deps.guideFiles || []) { try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); } catch (_) {} }
    return null;
  }
  function openGuide() {
    try {
      if (guideWin && !(guideWin.isDestroyed && guideWin.isDestroyed())) { try { guideWin.focus(); } catch (_) {} return { ok: true, already: true }; }
      const md = guideText();
      const html = guideRender.page(md || `# User guide\n\nThe guide file was not found next to the app. Read it online: [the AutoInjector user guide](${GUIDE_URL}).`);
      const { BaseWindow, WebContentsView } = deps;
      if (!BaseWindow || !WebContentsView) return { ok: false, error: 'NO_WINDOW' };
      guideWin = new BaseWindow({ width: 1060, height: 780, title: 'AutoInjector — User guide' });
      guideView = new WebContentsView({ webPreferences: { partition: 'ease-guide', contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false } });
      guideWin.contentView.addChildView(guideView);
      const fit = () => { try { const [w, h] = guideWin.getContentSize(); guideView.setBounds({ x: 0, y: 0, width: w, height: h }); } catch (_) {} };
      fit();
      if (guideWin.on) guideWin.on('resize', fit);
      const wc = guideView.webContents;
      const ext = (url) => { try { if (/^https?:\/\//i.test(url) && deps.shell && deps.shell.openExternal) Promise.resolve(deps.shell.openExternal(url)).catch(() => {}); } catch (_) {} };
      try { if (wc.setWindowOpenHandler) wc.setWindowOpenHandler(({ url }) => { ext(url); return { action: 'deny' }; }); } catch (_) {}
      try { if (wc.on) wc.on('will-navigate', (e, url) => { if (!/^data:/.test(url)) { e.preventDefault(); ext(url); } }); } catch (_) {}
      wc.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
      if (guideWin.on) guideWin.on('closed', () => { try { if (guideView && !guideView.webContents.isDestroyed()) guideView.webContents.close(); } catch (_) {} guideWin = null; guideView = null; });
      log('guide', { found: !!md });
      return { ok: true, found: !!md };
    } catch (e) { log('guide-error', { error: String((e && e.message) || e).slice(0, 120) }); return { ok: false, error: 'GUIDE_FAILED' }; }
  }

  const ipcMain = deps.ipcMain;
  if (ipcMain) {
    const safe = (fn) => async (_e, a) => { try { return await fn(a || {}); } catch (e) { log('ipc-error', { error: String((e && e.code) || 'ERROR') }); return { ok: false, error: 'FAILED', message: 'Something went wrong on my side.' }; } };
    ipcMain.handle('ease:prefs', safe(async () => Object.assign({ ok: true, auto }, prefs.get())));
    ipcMain.handle('ease:set-prefs', safe(async (a) => Object.assign({ ok: true, auto }, prefs.set(a))));
    ipcMain.handle('ease:checklist', safe(checklist));
    ipcMain.handle('ease:problems', safe(problems));
    ipcMain.handle('ease:report', safe(report));
    ipcMain.handle('ease:report-show', safe(async () => {
      if (!lastReport) return { ok: false, error: 'NO_REPORT', message: 'Make the report first.' };
      const a = deps.actions || {};
      return typeof a.showFile === 'function' ? a.showFile(lastReport) : { ok: false, error: 'NOT_AVAILABLE', message: 'Open the logs folder in “stuff and thing” to find it.' };
    }));
    ipcMain.handle('ease:fix', safe((a) => runFix(String(a.action || ''), a.args && typeof a.args === 'object' ? a.args : {})));
    ipcMain.handle('ease:guide', safe(async () => openGuide()));
  }

  /** The Help menu's ease items (main.js puts them in its menu template). show(what): tell the panel to open it. */
  function helpMenuItems(show) {
    return [
      { label: '✅ Setup checklist', click: () => show('checklist') },
      { label: "🩺 Something's wrong?", click: () => show('problems') },
      { label: '📖 User guide', click: () => openGuide() },
      { label: '🧭 Replay tours', click: () => show('tours') },
    ];
  }

  return { checklist, problems, report, runFix, openGuide, helpMenuItems, prefs, auto };
}

module.exports = { installEase, autoAllowed, MAIN_ACTIONS, GUIDE_URL };
