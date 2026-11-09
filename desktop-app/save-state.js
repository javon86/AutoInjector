'use strict';
/*
 * save-state.js — 💾 Save state / 📂 Load state: where you were, put back in one click.
 *
 * A save remembers:
 *   1. the three chats — the exact ChatGPT / Claude / Gemini conversation each pane is on (its address), so each pane
 *      can reopen that chat and keep talking;
 *   2. a backup copy of each chat's recent text (the replies AutoInjector already captured), shown read-only when a
 *      site's chat is gone;
 *   3. the set-up: which AIs are on (Active), the Compose box text, whether 🎩 Alfred is included in → All, the open
 *      tab, each pane's size (open / reduced / minimized), the folded panels, the window size, each pane's zoom;
 *   4. what you were doing: the 📖 Akọwe book that was open (when known) and the relay set-up (who forwards to whom,
 *      Auto, roles, the hop limit) and the 🧵 prompt sequence.
 *
 * Saves stay on this PC: one JSON file per save in AutoInjector's own data folder (userData/saved-states), written
 * atomically (temp file + rename), with safe file names, a limit (MAX_SAVES) and graceful handling of damaged files.
 * Nothing here talks to the network. Loading only ever opens chat addresses on the real AI sites
 * (isAllowedChatUrl) — anything else in a save file is refused.
 *
 * Electron-free; main.js does the panes / window / renderer parts. Unit-tested in test/save-state.test.js.
 */
const fsMod = require('fs');
const pathMod = require('path');

const FORMAT = 'autoinjector-saved-state';
const VERSION = 1;
const MAX_SAVES = 200;
const MAX_NAME = 80;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 16 * 1024;
const SITE_IDS = ['chatgpt', 'claude', 'gemini'];
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
// The real AI sites (https only, these exact hosts).
const CHAT_HOSTS = { chatgpt: ['chatgpt.com', 'chat.openai.com'], claude: ['claude.ai'], gemini: ['gemini.google.com'] };
const BACKUP_TURNS = 30;           // recent replies kept per pane
const BACKUP_TURN_CHARS = 12000;   // each reply cut to this
const BACKUP_SITE_CHARS = 200000;  // all of one pane's backup
const COMPOSER_MAX = 20000;
const TABS = ['main', 'akowe', 'images', 'video'];
const PANE_STATES = ['open', 'reduced', 'min'];
const PANELS = ['global', 'houserules', 'prompts', 'gpu', 'systemai', 'akowe'];

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function cleanText(s, max) {
  // no control characters except new lines / tabs
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

/** A save's name: trimmed, one line, 1..MAX_NAME characters. -> string or '' (not usable) */
function cleanName(name) {
  return cleanText(name, 500).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
}
/** A safe file id from a name: letters/digits/dashes only, plus a time stamp so two saves never clash. */
function makeId(name, now = Date.now(), rand = Math.random) {
  const slug = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'save';
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-').toLowerCase();
  const r = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0');
  return `${slug}-${stamp}-${r}`;
}
const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

// ---- chat addresses ---------------------------------------------------------------------------------------------
/**
 * May a save open this address in `site`'s pane? Only https on that AI's real site (no user:password, no other
 * port). `testBase` (the e2e tests' fake page, AUTOINJECTOR_SITE_URL_<SITE>) also allows that same loopback origin /
 * file. -> { ok, url?, why? }
 */
function isAllowedChatUrl(site, url, { testBase } = {}) {
  if (!CHAT_HOSTS[site]) return { ok: false, why: 'BAD_SITE' };
  const s = String(url == null ? '' : url).trim();
  if (!s || s.length > 2000) return { ok: false, why: 'NO_URL' };
  let u;
  try { u = new URL(s); } catch (_) { return { ok: false, why: 'NOT_A_URL' }; }
  if (u.username || u.password) return { ok: false, why: 'NOT_ALLOWED' };
  if (testBase) {
    try {
      const b = new URL(testBase);
      if (b.protocol === 'file:' && u.protocol === 'file:' && u.pathname === b.pathname) return { ok: true, url: u.href };
      if (/^http:$/.test(b.protocol) && /^(127\.0\.0\.1|localhost)$/.test(b.hostname) && u.origin === b.origin) return { ok: true, url: u.href };
    } catch (_) { /* not a test base */ }
  }
  if (u.protocol !== 'https:' || u.port) return { ok: false, why: 'NOT_ALLOWED' };
  if (!CHAT_HOSTS[site].includes(u.hostname.toLowerCase())) return { ok: false, why: 'NOT_ALLOWED' };
  return { ok: true, url: u.href };
}
/** Does the address look like one particular conversation (not the site's start page)? */
function looksLikeConversation(site, url) {
  try {
    const p = new URL(url).pathname;
    if (site === 'chatgpt') return /\/c\/[^/]+/.test(p);
    if (site === 'claude') return /\/chat\/[^/]+/.test(p);
    if (site === 'gemini') return /\/app\/[^/]+/.test(p) || /\/gem\/[^/]+\/[^/]+/.test(p);
  } catch (_) { return false; }
  return false;
}
function pathOf(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname.replace(/\/+$/, '')}`; } catch (_) { return String(url || ''); }
}
const LOGIN_HOST = /^(accounts\.google\.com|auth\.openai\.com|auth0\.openai\.com|login\.microsoftonline\.com)$/i;
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|auth|signup|sign-up|logout)(\/|$)/i;
const GONE_TEXT = /(conversation|chat) (not found|doesn['’]t exist|does not exist|was deleted|has been deleted|is no longer available|isn['’]t available)|(couldn['’]t|could not|unable to) (find|load) (this|that|the) (chat|conversation)|page not found|\b404\b/i;

/**
 * Where a pane really landed after opening a saved chat. -> { state, say }
 *   state: ok | gone (404 / "not found") | login (signed out) | new-chat (sent somewhere else) | error (did not load)
 */
function judgeLanding({ site, wanted, finalUrl, httpCode, pageSaysGone, loadError } = {}) {
  const name = LABELS[site] || site;
  if (Number(httpCode) === 404 || Number(httpCode) === 410) return { state: 'gone', say: `${name}: that chat is gone (the site can't find it any more). Here is the saved copy instead.` };
  if (loadError) return { state: 'error', say: `${name}: the saved chat didn't open (${String(loadError).slice(0, 80)}). Is the internet on? Here is the saved copy instead.` };
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch (_) {}
  const pathPart = (() => { try { return new URL(finalUrl).pathname; } catch (_) { return ''; } })();
  if (LOGIN_HOST.test(host) || LOGIN_PATH.test(pathPart)) return { state: 'login', say: `${name} is asking you to sign in. Sign in in its pane, then press 📂 Load state again. Here is the saved copy for now.` };
  if (Number(httpCode) === 404 || Number(httpCode) === 410 || pageSaysGone) return { state: 'gone', say: `${name}: that chat is gone (the site can't find it any more). Here is the saved copy instead.` };
  if (wanted && finalUrl && pathOf(wanted) !== pathOf(finalUrl) && looksLikeConversation(site, wanted)) {
    return { state: 'new-chat', say: `${name} opened a different page instead of the saved chat (the chat may have been deleted). Here is the saved copy instead.` };
  }
  if (Number(httpCode) >= 500) return { state: 'error', say: `${name}'s site had a problem opening the chat (error ${Number(httpCode)}). Try 📂 Load again later. Here is the saved copy for now.` };
  return { state: 'ok', say: `${name}: back on the saved chat.` };
}

// ---- building a save --------------------------------------------------------------------------------------------
/** The recent replies of each pane, for the read-only backup. transcript: [{ site, text, ts }] (oldest first) */
function backupOf(transcript, { perSite = BACKUP_TURNS, turnChars = BACKUP_TURN_CHARS, siteChars = BACKUP_SITE_CHARS } = {}) {
  const out = {};
  for (const site of SITE_IDS) {
    const turns = (Array.isArray(transcript) ? transcript : []).filter((t) => t && t.site === site && typeof t.text === 'string' && t.text.trim());
    const recent = turns.slice(-perSite);
    let used = 0;
    const kept = [];
    for (let i = recent.length - 1; i >= 0; i--) { // newest first, so the newest survive the size cap
      const text = cleanText(recent[i].text, turnChars);
      if (used + text.length > siteChars) break;
      used += text.length;
      kept.unshift({ ts: Number(recent[i].ts) || 0, text });
    }
    out[site] = kept;
  }
  return out;
}
const bool = (x, d) => (typeof x === 'boolean' ? x : d);

/** Clean the window's own bits (from controls.js snapshot()); anything unknown is dropped. */
function cleanUi(ui) {
  const u = isObj(ui) ? ui : {};
  const out = {};
  if (typeof u.composer === 'string') out.composer = cleanText(u.composer, COMPOSER_MAX);
  if (typeof u.alfredActive === 'boolean') out.alfredActive = u.alfredActive;
  if (TABS.includes(u.tab)) out.tab = u.tab;
  if (isObj(u.columns)) { out.columns = {}; for (const s of SITE_IDS) if (PANE_STATES.includes(u.columns[s])) out.columns[s] = u.columns[s]; }
  if (typeof u.mainRowCollapsed === 'boolean') out.mainRowCollapsed = u.mainRowCollapsed;
  if (Array.isArray(u.panelsCollapsed)) out.panelsCollapsed = Array.from(new Set(u.panelsCollapsed.filter((p) => PANELS.includes(p))));
  return out;
}
function cleanSites(x) { const out = {}; for (const s of SITE_IDS) if (isObj(x) && typeof x[s] === 'boolean') out[s] = x[s]; return out; }
function cleanRouting(r) {
  const out = {};
  for (const s of SITE_IDS) out[s] = Array.from(new Set((isObj(r) && Array.isArray(r[s]) ? r[s] : []).filter((t) => SITE_IDS.includes(t) && t !== s)));
  return out;
}
function cleanSequence(seq) {
  const steps = (isObj(seq) && Array.isArray(seq.steps) ? seq.steps : []).slice(0, 50)
    .map((s) => ({ target: isObj(s) && (s.target === 'all' || SITE_IDS.includes(s.target)) ? s.target : null, text: cleanText(isObj(s) ? s.text : '', 8000).trim() }))
    .filter((s) => s.target && s.text);
  return { steps, at: Math.max(0, Math.min(steps.length, Number(isObj(seq) && seq.at) || 0)), wasRunning: !!(isObj(seq) && seq.wasRunning) };
}
function cleanWindow(w) {
  if (!isObj(w)) return null;
  const n = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : null);
  const width = n(w.width, 400, 20000); const height = n(w.height, 300, 20000);
  if (!width || !height) return null;
  return { width, height, maximized: !!w.maximized };
}
function cleanAkowe(a) {
  if (!isObj(a)) return null;
  const project = cleanText(a.project_id || a.projectId || '', 200).trim();
  // the tab's own address part (#/p/<book>/…) — never a sign-in key
  const hash = typeof a.hash === 'string' && /^#\/p\/[^\s]{1,400}$/.test(a.hash) && !/token=/i.test(a.hash) ? a.hash : '';
  if (!project && !hash) return null;
  return { project_id: project, title: cleanText(a.title || '', 200).trim(), hash };
}

/**
 * Everything a save holds, cleaned (used both when saving and when reading a file back — a file may have been edited
 * by hand, so nothing in it is trusted).
 */
function cleanData(d) {
  const x = isObj(d) ? d : {};
  const panes = {};
  for (const s of SITE_IDS) {
    const p = isObj(x.panes) && isObj(x.panes[s]) ? x.panes[s] : null;
    if (!p) continue;
    panes[s] = { url: cleanText(p.url || '', 2000).trim(), title: cleanText(p.title || '', 200).trim(), zoom: Number.isFinite(Number(p.zoom)) ? Math.max(0.4, Math.min(2, Number(p.zoom))) : null };
  }
  const backup = {};
  for (const s of SITE_IDS) {
    const list = isObj(x.backup) && Array.isArray(x.backup[s]) ? x.backup[s] : [];
    backup[s] = list.slice(-BACKUP_TURNS).filter((t) => isObj(t) && typeof t.text === 'string').map((t) => ({ ts: Number(t.ts) || 0, text: cleanText(t.text, BACKUP_TURN_CHARS) }));
  }
  const setup = isObj(x.setup) ? x.setup : {};
  const relay = isObj(x.relay) ? x.relay : {};
  const roles = {};
  for (const s of SITE_IDS) if (isObj(relay.roles) && typeof relay.roles[s] === 'string') roles[s] = cleanText(relay.roles[s], 200);
  const hop = Number(relay.hopLimit);
  return {
    panes,
    backup,
    setup: { enabled: cleanSites(setup.enabled), ui: cleanUi(setup.ui), window: cleanWindow(setup.window) },
    relay: {
      routing: cleanRouting(relay.routing), meshActive: bool(relay.meshActive, false), relayEnabled: bool(relay.relayEnabled, true), roles,
      hopLimit: Number.isInteger(hop) && hop >= 0 && hop <= 100 ? hop : null,
    },
    sequence: cleanSequence(x.sequence),
    akowe: cleanAkowe(x.akowe),
  };
}

/** The short summary shown in the 📂 list (it sits at the top of the file so the list reads only that). */
function summaryOf(data) {
  const sites = {};
  for (const s of SITE_IDS) {
    const p = data.panes[s];
    sites[s] = { url: !!(p && p.url), conversation: !!(p && p.url && looksLikeConversation(s, p.url)), on: data.setup.enabled[s] !== false, turns: (data.backup[s] || []).length };
  }
  return { sites, book: data.akowe ? (data.akowe.title || data.akowe.project_id || 'a book') : '', tab: data.setup.ui.tab || 'main', sequenceSteps: data.sequence.steps.length };
}

/** The file text: line 1 is the header (format, name, time, summary), then the data. */
function serialize({ name, savedAt, data }) {
  const head = { format: FORMAT, version: VERSION, name, savedAt, summary: summaryOf(data) };
  return `${JSON.stringify(head).slice(0, -1)},\n"data":${JSON.stringify(data)}}\n`;
}
/** Read a whole file's text back. -> { ok, name, savedAt, data } | { ok:false, error:'DAMAGED' } */
function parse(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch (_) { return { ok: false, error: 'DAMAGED' }; }
  if (!isObj(o) || o.format !== FORMAT || !isObj(o.data)) return { ok: false, error: 'DAMAGED' };
  if (Number(o.version) > VERSION) return { ok: false, error: 'TOO_NEW' };
  const name = cleanName(o.name) || 'Saved state';
  return { ok: true, name, savedAt: Number(o.savedAt) || 0, data: cleanData(o.data) };
}
function parseHead(text) {
  const first = String(text).split('\n', 1)[0];
  if (!first.endsWith(',')) return null;
  try {
    const h = JSON.parse(`${first.slice(0, -1)}}`);
    if (!isObj(h) || h.format !== FORMAT || typeof h.name !== 'string' || !Number.isFinite(Number(h.savedAt))) return null;
    return h;
  } catch (_) { return null; }
}

// ---- the store (one folder, one file per save) ------------------------------------------------------------------
function createStore({ dir, fs = fsMod, now = Date.now, max = MAX_SAVES, onError } = {}) {
  if (!dir) throw new Error('save-state: no folder');
  const fileOf = (id) => pathMod.join(dir, `${id}.json`);
  const err = (e) => { try { if (onError) onError(e); } catch (_) {} };
  function ensureDir() { fs.mkdirSync(dir, { recursive: true }); }
  function ids() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    return names.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(validId);
  }
  function readHead(id) {
    let fd = null;
    try {
      const st = fs.statSync(fileOf(id));
      fd = fs.openSync(fileOf(id), 'r');
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return { head: parseHead(buf.slice(0, n).toString('utf8')), size: st.size, mtime: st.mtimeMs };
    } catch (e) { err(e); return { head: null, size: 0, mtime: 0 }; } finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
  }
  /** Every save, newest first. Damaged files are listed (so they can be deleted) with damaged: true. */
  function list() {
    const out = [];
    for (const id of ids()) {
      const { head, size, mtime } = readHead(id);
      if (head && size <= MAX_FILE_BYTES) out.push({ id, name: cleanName(head.name) || 'Saved state', savedAt: Number(head.savedAt) || mtime || 0, summary: isObj(head.summary) ? head.summary : null, damaged: false });
      else out.push({ id, name: `Damaged save (${id.slice(0, 40)})`, savedAt: mtime || 0, summary: null, damaged: true });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
  }
  function read(id) {
    if (!validId(id)) return { ok: false, error: 'NOT_FOUND' };
    let text;
    try {
      const st = fs.statSync(fileOf(id));
      if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'DAMAGED', id };
      text = fs.readFileSync(fileOf(id), 'utf8');
    } catch (e) { return { ok: false, error: e && e.code === 'ENOENT' ? 'NOT_FOUND' : 'READ_FAILED', id }; }
    const r = parse(text);
    return Object.assign({ id }, r);
  }
  /** Find a save by id, or by name (exact, then the only one that starts with / contains it — any case). */
  function find(ref) {
    const all = list();
    const s = String(ref == null ? '' : ref).trim();
    if (!s) return { ok: false, error: 'NOT_FOUND' };
    const byId = all.find((x) => x.id === s);
    if (byId) return { ok: true, save: byId };
    const low = cleanName(s).toLowerCase();
    const exact = all.filter((x) => !x.damaged && x.name.toLowerCase() === low);
    if (exact.length) return { ok: true, save: exact[0] };
    for (const test of [(n) => n.startsWith(low), (n) => n.includes(low)]) {
      const m = all.filter((x) => !x.damaged && test(x.name.toLowerCase()));
      if (m.length === 1) return { ok: true, save: m[0] };
      if (m.length > 1) return { ok: false, error: 'AMBIGUOUS', matches: m.slice(0, 8).map((x) => x.name) };
    }
    return { ok: false, error: 'NOT_FOUND' };
  }
  function writeAtomic(id, text) {
    ensureDir();
    const tmp = pathMod.join(dir, `.${id}.${process.pid}.${Math.floor(Math.random() * 1e9)}.tmp`);
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, fileOf(id));
    } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} throw e; }
  }
  /**
   * Save `data` under `name`. A save with the same name (any case) is replaced only with replace: true.
   * -> { ok, id, name, savedAt, replaced } | { ok:false, error: NO_NAME | NAME_TAKEN | TOO_MANY | WRITE_FAILED }
   */
  function save(name, data, { replace = false } = {}) {
    const nm = cleanName(name);
    if (!nm) return { ok: false, error: 'NO_NAME' };
    const all = list();
    const same = all.find((x) => !x.damaged && x.name.toLowerCase() === nm.toLowerCase());
    if (same && !replace) return { ok: false, error: 'NAME_TAKEN', id: same.id, name: same.name };
    if (!same && all.length >= max) return { ok: false, error: 'TOO_MANY', max };
    const savedAt = now();
    const id = same ? same.id : makeId(nm, savedAt);
    try { writeAtomic(id, serialize({ name: nm, savedAt, data: cleanData(data) })); } catch (e) { err(e); return { ok: false, error: 'WRITE_FAILED', code: e && e.code }; }
    return { ok: true, id, name: nm, savedAt, replaced: !!same };
  }
  function rename(id, name) {
    const nm = cleanName(name);
    if (!nm) return { ok: false, error: 'NO_NAME' };
    const r = read(id);
    if (!r.ok) return r;
    const clash = list().find((x) => x.id !== id && !x.damaged && x.name.toLowerCase() === nm.toLowerCase());
    if (clash) return { ok: false, error: 'NAME_TAKEN', name: clash.name };
    try { writeAtomic(id, serialize({ name: nm, savedAt: r.savedAt, data: r.data })); } catch (e) { err(e); return { ok: false, error: 'WRITE_FAILED' }; }
    return { ok: true, id, name: nm };
  }
  function remove(id) {
    if (!validId(id)) return { ok: false, error: 'NOT_FOUND' };
    try { fs.unlinkSync(fileOf(id)); return { ok: true, id }; } catch (e) { return { ok: false, error: e && e.code === 'ENOENT' ? 'NOT_FOUND' : 'DELETE_FAILED' }; }
  }
  return { list, read, find, save, rename, remove, dir, max };
}

// ---- loading ----------------------------------------------------------------------------------------------------
/**
 * What loading `data` will do to each pane. testBases: { site: AUTOINJECTOR_SITE_URL_<SITE> } (tests only).
 * -> { open: { site: url }, refused: { site: { why, say } }, none: [sites with no saved address] }
 */
function planLoad(data, { testBases = {} } = {}) {
  const d = cleanData(data);
  const open = {}; const refused = {}; const none = [];
  for (const s of SITE_IDS) {
    const p = d.panes[s];
    if (!p || !p.url) { none.push(s); continue; }
    const v = isAllowedChatUrl(s, p.url, { testBase: testBases[s] });
    if (v.ok) open[s] = v.url;
    else refused[s] = { why: v.why, say: `${LABELS[s]}: the saved address isn't a ${LABELS[s]} chat address, so it was not opened (only ${CHAT_HOSTS[s].join(' / ')} chats are).` };
  }
  return { open, refused, none, data: d };
}

/** The question when something is working (activity from run-guard.js activityOf; extra = more plain reasons). */
function busyQuestion(activity, extra = []) {
  const why = [].concat((activity && activity.busy && activity.why) || [], (extra || []).filter(Boolean));
  if (!why.length) return null;
  return {
    why,
    message: `Something is still working: ${why.join(', ')}. Loading a save now moves the AI panes to other chats, which can spoil that work. Load it anyway?`,
  };
}

/** Plain words for an error code. */
function sayError(r) {
  const e = r && r.error;
  if (e === 'NO_NAME') return 'Type a name for the save first.';
  if (e === 'NAME_TAKEN') return `There is already a save called “${(r && r.name) || 'that'}”. Pick another name, or replace it.`;
  if (e === 'TOO_MANY') return `You have ${(r && r.max) || MAX_SAVES} saves — that is the most AutoInjector keeps. Delete some old ones first (📂 Load state → 🗑).`;
  if (e === 'WRITE_FAILED') return 'The save could not be written to disk (is the disk full?).';
  if (e === 'NOT_FOUND') return 'That save was not found (it may have been deleted).';
  if (e === 'AMBIGUOUS') return `More than one save matches: ${((r && r.matches) || []).join(', ')}. Say which one.`;
  if (e === 'DAMAGED') return 'That save file is damaged and cannot be loaded. You can delete it.';
  if (e === 'TOO_NEW') return 'That save was made by a newer AutoInjector. Update AutoInjector to load it.';
  if (e === 'BUSY') return (r && r.message) || 'Something is still working.';
  return (r && r.message) || 'Something went wrong.';
}

module.exports = {
  createStore, isAllowedChatUrl, looksLikeConversation, judgeLanding, backupOf, cleanData, cleanUi, cleanName, makeId, validId,
  serialize, parse, parseHead, summaryOf, planLoad, busyQuestion, sayError,
  FORMAT, VERSION, MAX_SAVES, MAX_NAME, CHAT_HOSTS, SITE_IDS, LABELS, GONE_TEXT,
};
