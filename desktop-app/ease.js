'use strict';
/*
 * ease.js — the ease-of-use helpers, as plain functions (no Electron, so they are unit-tested on their own):
 *
 *   ✅ Setup checklist  buildChecklist(snap) -> { items, neededOk, neededBad, summary }
 *       One row per thing the app can use, each ✔ (ok:true), ✖ (ok:false) or ⏳ (ok:null, "not sure yet"),
 *       grouped "needed for books" / "optional extras", each with a "Fix it" action the panel runs.
 *       It only READS what the existing checks already found (self-repair's pane states, Akọwe's server status,
 *       llm-setup's status, the setup manager's install check, the Images / Video status, Akọwe's
 *       /settings/claude-code status, the content folder choice and the health watch's free-space numbers).
 *
 *   🩺 Something's wrong?  findProblems(snap) -> [{ id, severity, text, fix }]  (the top few, worst first)
 *       From the health watch's problems, the run guard's "your book needs you" conditions (paused run, every AI
 *       at its limit, a pane logged out / broken), the pane states, Akọwe's server and the voice engine, plus
 *       scanLog(): the activity log of the LAST 24 HOURS, read by event kind and level only (never any text).
 *
 *   Settings: createPrefs(file) — "don't show the checklist again", when it was first shown, and which guided
 *       tours were seen. A small JSON file next to the app's other settings.
 *
 * A fix is { label, action, args } — the panel (ease-ui.js) knows each action; nothing here runs anything.
 */
const fs = require('fs');
const path = require('path');

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const DISK_WARN = 15 * GB;   // the same limits as health-watch.js
const DISK_URGENT = 5 * GB;
const MAX_PROBLEMS = 5;

function gbText(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '?';
  const g = bytes / GB;
  return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}
const fix = (label, action, args) => ({ label, action, args: args || {} });
const str = (v, max = 300) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max));

// ------------------------------------------------------------------------------------------ the checklist
function paneItem(x) {
  const L = str(x.label, 40) || x.site;
  const base = { id: `pane-${x.site}`, group: 'needed', title: `Signed in to ${L}` };
  if (!x.active) return Object.assign(base, { ok: false, text: `${L} is switched off (its Active box is unticked), so it gets no work.`, fix: fix(`Turn ${L} on`, 'pane-on', { site: x.site }) });
  const st = x.state || 'unknown';
  if (st === 'ok') return Object.assign(base, { ok: true, text: `${L} is signed in and answering.` });
  if (st === 'needs_user') {
    if (x.problem === 'USAGE_LIMIT') return Object.assign(base, { ok: true, text: `${L} is signed in, but it says you have reached its usage limit for now. It carries on by itself when the limit resets.` });
    if (x.problem === 'CAPTCHA') return Object.assign(base, { ok: false, text: `${L} is showing an "are you a human?" check.`, fix: fix(`Open ${L}`, 'pane-open', { site: x.site }) });
    return Object.assign(base, { ok: false, text: `${L} is not signed in. Open its window and sign in once — the site remembers you.`, fix: fix(`Open ${L} to sign in`, 'pane-open', { site: x.site }) });
  }
  if (st === 'broken') return Object.assign(base, { ok: false, text: `${L} is not answering, and AutoInjector could not fix it by itself.`, fix: fix(`Open ${L}`, 'pane-open', { site: x.site }) });
  if (st === 'repairing') return Object.assign(base, { ok: null, text: `AutoInjector is checking ${L} right now…` });
  return Object.assign(base, { ok: null, text: `Not checked yet. If ${L} shows its chat page, you are signed in.`, fix: fix('Check now', 'pane-check', { site: x.site }) });
}

function akoweItem(a) {
  const base = { id: 'akowe', group: 'needed', title: 'Akọwe (the book writer) is running' };
  if (!a) return Object.assign(base, { ok: null, text: 'Could not tell yet.' });
  if (a.phase === 'running') return Object.assign(base, { ok: true, text: 'Akọwe is running. Open it with the 📖 Akọwe tab.', fix: fix('Open 📖 Akọwe', 'tab', { tab: 'akowe' }) });
  if (['preparing', 'installing', 'starting', 'restarting'].includes(a.phase)) return Object.assign(base, { ok: null, text: str(a.message) || 'Akọwe is starting…' });
  if (a.enabled === false) return Object.assign(base, { ok: false, text: 'Akọwe is switched off, so books cannot be written.', fix: fix('▶ Turn it on and start it', 'akowe-on') });
  const noPython = /PYTHON/i.test(String(a.error || '')) && a.pythonDownloadUrl;
  if (noPython) return Object.assign(base, { ok: false, text: str(a.message) || 'Akọwe needs Python 3.10 or newer, which was not found on this PC.', fix: fix('Get Python', 'open-url', { url: a.pythonDownloadUrl }) });
  return Object.assign(base, { ok: false, text: str(a.message) || 'Akọwe is not running.', fix: fix('▶ Start Akọwe', 'akowe-start') });
}

function llmItem(l) {
  const base = { id: 'alfred-ai', group: 'optional', title: "Alfred's AI (Ollama and a model)" };
  if (!l || l.ok === false) return Object.assign(base, { ok: null, text: 'Could not tell yet.', fix: fix('🧙 Open the setup', 'wizard', { tab: 'localai' }) });
  const installed = !!(l.ollama && l.ollama.installed);
  const running = !!(l.server && l.server.running);
  const n = Array.isArray(l.models) ? l.models.length : 0;
  if (running && n) return Object.assign(base, { ok: true, text: `Ollama is running with ${n} model${n === 1 ? '' : 's'}.` });
  if (running) return Object.assign(base, { ok: false, text: 'Ollama is running, but no model is downloaded yet.', fix: fix('🧙 Choose a model', 'wizard', { tab: 'localai' }) });
  if (installed) return Object.assign(base, { ok: false, text: 'Ollama is installed but not running.', fix: fix('▶ Start Ollama', 'llm-start') });
  return Object.assign(base, { ok: false, text: 'Ollama (the program that runs Alfred\'s own AI on this PC) is not installed. Alfred can also use one of the AI panes instead.', fix: fix('🧙 Set it up', 'wizard', { tab: 'localai' }) });
}

function voiceItem(v) {
  const base = { id: 'voice', group: 'optional', title: 'Voice engine (talk to the AIs with 🎤)' };
  if (!v || v.installed == null) return Object.assign(base, { ok: null, text: str(v && v.reason) || 'Could not tell yet.', fix: fix('🧙 Open the installs', 'wizard', { tab: 'advanced' }) });
  if (v.installed) return Object.assign(base, { ok: true, text: v.running ? 'The voice engine is installed and running.' : 'The voice engine is installed. It starts by itself when you press 🎤.' });
  return Object.assign(base, { ok: false, text: str(v.reason) ? `Not installed (${str(v.reason, 120)}). Reading replies aloud works without it.` : 'Not installed. Reading replies aloud works without it; speaking to the AIs needs it.', fix: fix('🧙 Install it', 'wizard', { tab: 'advanced' }) });
}

function sdItem(s) {
  const base = { id: 'sd', group: 'optional', title: 'Stable Diffusion (pictures on your PC)' };
  if (!s) return Object.assign(base, { ok: null, text: 'Could not tell yet.', fix: fix('Open 🎨 Images', 'tab', { tab: 'images' }) });
  if (s.connected && s.noModels) return Object.assign(base, { ok: false, text: `Connected to ${str(s.label, 40) || 'Stable Diffusion'}, but it has no picture model loaded.`, fix: fix('Open 🎨 Images', 'tab', { tab: 'images' }) });
  if (s.connected) return Object.assign(base, { ok: true, text: `Connected to ${str(s.label, 40) || 'Stable Diffusion'}.` });
  const found = Array.isArray(s.found) ? s.found.filter(Boolean) : [];
  if (found.length) return Object.assign(base, { ok: true, text: `Found ${found.slice(0, 2).map((x) => str(x, 40)).join(' and ')} on this PC (not started). AutoInjector can start it from 🎨 Images.`, fix: fix('Open 🎨 Images', 'tab', { tab: 'images' }) });
  return Object.assign(base, { ok: false, text: 'No Stable Diffusion found. 🎨 Images can install one, or pictures can be made by ChatGPT.', fix: fix('Open 🎨 Images', 'tab', { tab: 'images' }) });
}

function videoItem(v) {
  const base = { id: 'video', group: 'optional', title: 'Video engine' };
  if (!v) return Object.assign(base, { ok: null, text: 'Could not tell yet.', fix: fix('Open 🎬 Video', 'tab', { tab: 'video' }) });
  if (v.ready) return Object.assign(base, { ok: true, text: str(v.message, 220) || 'Ready.' });
  return Object.assign(base, { ok: false, text: str(v.message, 260) || 'Video is not set up yet.', fix: fix('Open 🎬 Video', 'tab', { tab: 'video' }) });
}

function claudeCodeItem(c, akoweRunning) {
  const base = { id: 'claude-code', group: 'optional', title: 'Claude Code helpers (make books faster)' };
  if (!akoweRunning) return Object.assign(base, { ok: null, text: 'Akọwe checks this once it is running.' });
  if (!c || !c.state) return Object.assign(base, { ok: null, text: 'Could not tell yet.', fix: fix('Open Akọwe ⚙️ Settings', 'claude-code') });
  const words = str(c.words, 260);
  if (c.state === 'ready') return Object.assign(base, { ok: true, text: words || 'Claude Code found, signed in.' });
  if (c.state === 'checking') return Object.assign(base, { ok: null, text: 'Akọwe is checking Claude Code…' });
  if (c.state === 'off') return Object.assign(base, { ok: null, text: words || 'Switched off — the web AIs do all the work.', fix: fix('Open Akọwe ⚙️ Settings', 'claude-code') });
  if (c.state === 'limited') return Object.assign(base, { ok: true, text: words || 'At your Claude plan\'s usage limit for now.' });
  return Object.assign(base, { ok: false, text: words || 'Not working right now — the web AIs do the work.', fix: fix('Open Akọwe ⚙️ Settings', 'claude-code') });
}

/** ⌨ Command-line AIs (Akọwe's /api/cli-mode, mirrored by cli-mode-watch.js): shown only when an AI slot uses it. */
function cliModeItem(c) {
  if (!c || !Array.isArray(c.slots)) return null;
  const on = c.slots.filter((s) => s && s.cli && s.site);
  if (!on.length) return null;
  const base = { id: 'cli-mode', group: 'optional', title: 'Command-line AIs (Claude Code / Codex)' };
  const TOOL = { claude: 'claude', chatgpt: 'codex' };
  const NAME = { claude: 'Claude Code', codex: 'Codex' };
  const lines = on.map((s) => { const t = (c.tools && c.tools[TOOL[s.site]]) || {}; return { ok: t.state === 'ready', checking: !t.state || t.state === 'checking', text: `${NAME[TOOL[s.site]]}: ${str(t.words, 160) || t.state || 'checking'}` }; });
  const text = lines.map((l) => l.text).join(' · ');
  if (lines.every((l) => l.ok)) return Object.assign(base, { ok: true, text });
  if (lines.some((l) => l.checking)) return Object.assign(base, { ok: null, text });
  return Object.assign(base, { ok: false, text, fix: fix('Open Akọwe ⚙️ Settings', 'claude-code') });
}

function contentItem(c) {
  const base = { id: 'content', group: 'needed', title: 'Content folder ("stuff and thing") chosen' };
  if (!c || !c.dir) return Object.assign(base, { ok: null, text: 'Could not tell yet.' });
  const other = Array.isArray(c.others) ? c.others[0] : null;
  if (other && !['chosen', 'found-earlier'].includes(c.reason)) {
    const what = Array.isArray(other.what) && other.what.length ? ` (${other.what.slice(0, 3).map((w) => str(w, 30)).join(', ')})` : '';
    return Object.assign(base, { ok: false, text: `Your earlier downloads${what} are in another AutoInjector folder: ${str(other.dir, 200)}. Using it saves downloading them again. (The app restarts.)`, fix: fix('📁 Use that folder', 'content-use', { root: other.root }) });
  }
  return Object.assign(base, { ok: true, text: `Pictures, videos, models and logs go into ${str(c.dir, 200)}.`, fix: fix('📂 Open it', 'open-folder', { path: c.dir }) });
}

function diskItem(d) {
  const base = { id: 'disk', group: 'needed', title: 'Enough free disk space' };
  if (!d || d.freeBytes == null || !Number.isFinite(d.freeBytes)) return Object.assign(base, { ok: null, text: 'Could not tell how much space is free.' });
  const free = gbText(d.freeBytes);
  const open = d.path ? fix('📂 Open the folder', 'open-folder', { path: d.path }) : undefined;
  if (d.freeBytes < DISK_URGENT) return Object.assign(base, { ok: false, text: `Only ${free} free — downloads, pictures and books can start failing. Free some space.`, fix: open });
  if (d.freeBytes < DISK_WARN) return Object.assign(base, { ok: true, text: `${free} free. One AI model needs 5–20 GB, so free some space before downloading more.`, fix: open });
  return Object.assign(base, { ok: true, text: `${free} free.` });
}

/** snap -> { items, neededOk, neededBad, summary }. Never throws: a broken part becomes a ⏳ row. */
function buildChecklist(snap = {}) {
  const items = [];
  const safe = (fn, fallback) => { try { const r = fn(); if (r) items.push(r); } catch (_) { items.push(Object.assign({ ok: null, text: 'Could not tell yet.' }, fallback)); } };
  const sites = Array.isArray(snap.sites) ? snap.sites : [];
  // ⌨ an AI that Akọwe runs on the command line does not need its web window signed in
  const cliSites = new Set(((snap.cliMode && snap.cliMode.slots) || []).filter((s) => s && s.cli).map((s) => s.site));
  for (const x of sites) {
    if (x && cliSites.has(x.site)) { items.push({ id: `pane-${x.site}`, group: 'optional', title: `Signed in to ${x.label || 'an AI'}`, ok: true, text: `Not needed for books: Akọwe uses ${x.site === 'claude' ? 'Claude Code' : 'Codex'} on the command line for ${x.label || x.site}.` }); continue; }
    safe(() => paneItem(x || {}), { id: `pane-${x && x.site}`, group: 'needed', title: `Signed in to ${(x && x.label) || 'an AI'}` });
  }
  safe(() => akoweItem(snap.akowe), { id: 'akowe', group: 'needed', title: 'Akọwe (the book writer) is running' });
  safe(() => contentItem(snap.content), { id: 'content', group: 'needed', title: 'Content folder chosen' });
  safe(() => diskItem(snap.disk), { id: 'disk', group: 'needed', title: 'Enough free disk space' });
  safe(() => llmItem(snap.llm), { id: 'alfred-ai', group: 'optional', title: "Alfred's AI" });
  safe(() => voiceItem(snap.voice), { id: 'voice', group: 'optional', title: 'Voice engine' });
  safe(() => sdItem(snap.sd), { id: 'sd', group: 'optional', title: 'Stable Diffusion' });
  safe(() => videoItem(snap.video), { id: 'video', group: 'optional', title: 'Video engine' });
  safe(() => cliModeItem(snap.cliMode), { id: 'cli-mode', group: 'optional', title: 'Command-line AIs' });
  safe(() => claudeCodeItem(snap.claudeCode, !!(snap.akowe && snap.akowe.phase === 'running')), { id: 'claude-code', group: 'optional', title: 'Claude Code helpers' });
  const needed = items.filter((i) => i.group === 'needed');
  const neededBad = needed.filter((i) => i.ok === false).length;
  const neededOk = needed.length > 0 && needed.every((i) => i.ok === true);
  const summary = neededOk ? '✔ Everything needed for books is ready.' : neededBad ? `${neededBad} thing${neededBad === 1 ? '' : 's'} needed for books ${neededBad === 1 ? 'needs' : 'need'} fixing.` : 'Still checking some things…';
  return { items, neededOk, neededBad, summary };
}

/** Show the checklist by itself? Only when allowed (not under automation, not "don't show again"): on the
 *  very first start, then whenever something needed is definitely ✖. Once all needed are ✔, it stays away. */
function shouldAutoOpen({ auto, prefs, checklist } = {}) {
  if (!auto) return false;
  const p = prefs || {};
  if (p.dontShowChecklist) return false;
  const c = checklist || { items: [] };
  if (c.neededOk) return false;
  if (!p.checklistShownAt) return true;
  return (c.items || []).some((i) => i.group === 'needed' && i.ok === false);
}

// ------------------------------------------------------------------------------------- the recent log (codes only)
// Which part of the app an event kind belongs to, in plain words, and where to fix it. Only the kind (a code like
// "sd-runner-error") and the level are read — never the event's details, so nothing private can reach the screen.
const LOG_AREAS = [
  { re: /^(sd-|image-|sdlib-|chatgpt-image)/, area: '🎨 Pictures (Stable Diffusion)', fix: fix('Open 🎨 Images', 'tab', { tab: 'images' }) },
  { re: /^(video-|framepack|trailer)/, area: '🎬 Video', fix: fix('Open 🎬 Video', 'tab', { tab: 'video' }) },
  { re: /^(akowe|bookforge|bf-)/, area: '📖 Akọwe', fix: fix('Open 📖 Akọwe', 'tab', { tab: 'akowe' }) },
  { re: /^voice/, area: '🎤 The voice engine', fix: fix('🧙 Open the installs', 'wizard', { tab: 'advanced' }) },
  { re: /^(ollama|llm-|alfred)/, area: "🎩 Alfred's AI", fix: fix('🧙 Open the setup', 'wizard', { tab: 'localai' }) },
  { re: /^(send|capture|self-repair|pane-|relay|fresh-chat|selector|picker|teach)/, area: '🤖 The AI panes (sending and reading)', fix: fix('🩺 Check the AIs now', 'pane-check', {}) },
  { re: /^(ai-download)/, area: '⬇ Files the AIs gave you', fix: null },
  { re: /^(mcp|tool|terminal|interpreter)/, area: '🧰 Tools', fix: null },
];
const IGNORE_KINDS = /^(selftest-|capability-test|health$|ui:|extract-all)/; // the app's own tests and reports, not problems
function isErrorEntry(e) {
  if (!e || typeof e.kind !== 'string') return false;
  if (e.level === 'error') return true;
  const sev = e.detail && typeof e.detail === 'object' ? e.detail.severity : null;
  return sev === 'error';
}
/** entries -> [{ area, kind, count, lastAt, fix }] for the last 24 hours, most frequent first. Only kinds and counts. */
function scanLog(entries, now = Date.now()) {
  const from = now - DAY;
  const by = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !Number.isFinite(e.ts) || e.ts < from || e.ts > now + 60000) continue;
    if (!isErrorEntry(e) || IGNORE_KINDS.test(e.kind)) continue;
    const kind = String(e.kind).replace(/[^\w:.-]/g, '').slice(0, 60);
    const a = LOG_AREAS.find((x) => x.re.test(kind));
    const key = a ? a.area : 'other';
    const cur = by.get(key) || { area: a ? a.area : 'Other parts of the app', kinds: new Map(), count: 0, lastAt: 0, fix: a ? a.fix : null };
    cur.count++;
    cur.lastAt = Math.max(cur.lastAt, e.ts);
    cur.kinds.set(kind, (cur.kinds.get(kind) || 0) + 1);
    by.set(key, cur);
  }
  return [...by.values()]
    .map((x) => ({ area: x.area, count: x.count, lastAt: x.lastAt, fix: x.fix, kinds: [...x.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ kind: k, count: n })) }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

// ------------------------------------------------------------------------------------------ the problems
function agoText(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}
/** snap -> the top problems, worst first: [{ id, severity: 'urgent'|'warn', text, fix }]. Empty = nothing wrong. */
function findProblems(snap = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const max = opts.max || MAX_PROBLEMS;
  const out = [];
  const seen = new Set(); // one row per thing (a pane, Akọwe …)
  const add = (p) => { if (!p || !p.text || seen.has(p.id)) return; seen.add(p.id); out.push(p); };

  // 1) your book run needs you / every AI at its limit / a pane logged out or broken (run-guard.js's words)
  for (const c of Array.isArray(snap.runConditions) ? snap.runConditions : []) {
    if (!c || !c.key) continue;
    const id = c.site ? `pane-${c.site}` : c.key.startsWith('run:') ? 'run' : c.key;
    const f = c.target === 'akowe' ? fix('Open 📖 Akọwe', 'tab', { tab: 'akowe' }) : c.site ? fix(`Open ${str(c.title, 40).replace(/ needs you$/, '') || 'that AI'}`, 'pane-open', { site: c.site }) : fix('Open the AI panes', 'tab', { tab: 'main' });
    add({ id, severity: 'urgent', text: `${str(c.title, 80)}: ${str(c.body, 300)}`, fix: f });
  }
  // 2) the panes (also when no run is going)
  const sites = Array.isArray(snap.sites) ? snap.sites : [];
  const active = sites.filter((x) => x && x.active);
  const limited = active.filter((x) => x.state === 'needs_user' && x.problem === 'USAGE_LIMIT');
  if (active.length && limited.length === active.length) add({ id: 'all-limited', severity: 'urgent', text: `Every AI (${active.map((x) => str(x.label, 30)).join(', ')}) says you have reached its usage limit. Work waits until a limit resets — or switch an AI to another account.`, fix: null });
  for (const x of active) {
    const L = str(x.label, 30) || x.site;
    if (x.state === 'needs_user' && x.problem === 'LOGGED_OUT') add({ id: `pane-${x.site}`, severity: 'urgent', text: `${L} is logged out. Sign in once in its window.`, fix: fix(`Open ${L}`, 'pane-open', { site: x.site }) });
    else if (x.state === 'needs_user' && x.problem === 'CAPTCHA') add({ id: `pane-${x.site}`, severity: 'urgent', text: `${L} is showing an "are you a human?" check. Complete it in its window.`, fix: fix(`Open ${L}`, 'pane-open', { site: x.site }) });
    else if (x.state === 'needs_user' && x.problem === 'USAGE_LIMIT' && limited.length !== active.length) add({ id: `pane-${x.site}`, severity: 'warn', text: `${L} has reached its usage limit. The other AIs take its work until it resets.`, fix: null });
    else if (x.state === 'broken') add({ id: `pane-${x.site}`, severity: 'urgent', text: `${L} stopped answering and AutoInjector could not fix it by itself. Look at its window; if the page looks different, use 🎯 Point at it.`, fix: fix(`Open ${L}`, 'pane-open', { site: x.site }) });
  }
  // 3) Akọwe's server
  const a = snap.akowe;
  if (a && a.enabled !== false && a.phase === 'failed') add({ id: 'akowe', severity: 'urgent', text: `📖 Akọwe is not running: ${str(a.message, 240) || 'it stopped'}.`, fix: /PYTHON/i.test(String(a.error || '')) && a.pythonDownloadUrl ? fix('Get Python', 'open-url', { url: a.pythonDownloadUrl }) : fix('▶ Start Akọwe', 'akowe-start') });
  // 4) the health watch (Alfred's brain / Ollama, disk, Stable Diffusion, Akọwe, logs, content, FramePack)
  for (const p of Array.isArray(snap.health) ? snap.health : []) {
    if (!p || !p.code) continue;
    const id = p.check === 'akowe' ? 'akowe' : p.check === 'panes' ? `health-${p.code}` : `health-${p.code}`;
    add({ id, severity: p.severity === 'urgent' ? 'urgent' : 'warn', text: str(p.text, 400), fix: p.fix && p.fix.label ? fix(str(p.fix.label, 60), 'health-fix', { code: p.code }) : null });
  }
  // 5) the voice engine was set up but would not start
  const v = snap.voice;
  if (v && v.installed && v.lastStartError) add({ id: 'voice', severity: 'warn', text: '🎤 The voice engine is installed but did not start, so 🎤 cannot hear you.', fix: fix('🧙 Open the installs', 'wizard', { tab: 'advanced' }) });
  // 6) the recent log: areas with errors in the last 24 hours (codes only)
  for (const g of scanLog(snap.log, now)) {
    if (g.count < (opts.minLogErrors || 3)) continue;
    const codes = g.kinds.map((k) => k.kind).join(', ');
    add({ id: `log-${g.area}`, severity: 'warn', text: `${g.area}: ${g.count} error${g.count === 1 ? '' : 's'} in the last 24 hours (last one ${agoText(g.lastAt, now)}; codes: ${codes}). If it keeps happening, make a report for support.`, fix: g.fix });
  }
  const rank = { urgent: 0, warn: 1 };
  out.sort((x, y) => rank[x.severity] - rank[y.severity]);
  return out.slice(0, max);
}

// ------------------------------------------------------------------------------------------ settings
function createPrefs(file) {
  const DEF = { dontShowChecklist: false, checklistShownAt: null, toursSeen: {} };
  let data = null;
  function load() {
    if (data) return data;
    data = JSON.parse(JSON.stringify(DEF));
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        data.dontShowChecklist = raw.dontShowChecklist === true;
        data.checklistShownAt = Number.isFinite(raw.checklistShownAt) ? raw.checklistShownAt : null;
        if (raw.toursSeen && typeof raw.toursSeen === 'object') for (const [k, v] of Object.entries(raw.toursSeen)) if (/^[a-z-]{1,20}$/.test(k) && v) data.toursSeen[k] = true;
      }
    } catch (_) { /* missing or unreadable: the defaults */ }
    return data;
  }
  function save() {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); } catch (_) { /* best effort */ }
  }
  return {
    get: () => JSON.parse(JSON.stringify(load())),
    set(patch = {}) {
      load();
      if (typeof patch.dontShowChecklist === 'boolean') data.dontShowChecklist = patch.dontShowChecklist;
      if (patch.checklistShown) data.checklistShownAt = data.checklistShownAt || Date.now();
      if (typeof patch.tourSeen === 'string' && /^[a-z-]{1,20}$/.test(patch.tourSeen)) data.toursSeen[patch.tourSeen] = true;
      if (patch.resetTours) data.toursSeen = {};
      save();
      return JSON.parse(JSON.stringify(data));
    },
  };
}

module.exports = { cliModeItem, buildChecklist, shouldAutoOpen, findProblems, scanLog, createPrefs, gbText, DISK_WARN, DISK_URGENT, MAX_PROBLEMS };
